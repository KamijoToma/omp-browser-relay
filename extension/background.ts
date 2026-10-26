/** MV3 transport; workspace.ts enforces dedicated-window ownership on every RPC. */
import type { ExtToRelayMessage, RelayToExtMessage, TailnetAccessResult } from "../src/protocol";
import { Workspace } from "./workspace";

const DEFAULT_PORT = 9224;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
let ws: WebSocket | null = null;
let connecting = false;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer: Timer | null = null;
let reconnectTimer: Timer | null = null;
let cleanup: Promise<void> = Promise.resolve();
let identity: Promise<string> | null = null;
interface PendingTailnetRequest {
	resolve(result: TailnetAccessResult): void;
	reject(error: Error): void;
	timer: Timer;
	reconnect?: Promise<WebSocket>;
}

interface RelayOpenWaiter {
	resolve(socket: WebSocket): void;
	reject(error: Error): void;
	timer: Timer;
}

interface RelayReconnectWaiter {
	previous: WebSocket;
	resolve(socket: WebSocket): void;
	reject(error: Error): void;
	timer: Timer;
}

const pendingTailnetRequests = new Map<number, PendingTailnetRequest>();
const relayOpenWaiters = new Set<RelayOpenWaiter>();
const relayReconnectWaiters = new Set<RelayReconnectWaiter>();
let nextTailnetRequestId = 0;

function waitForRelaySocket(): Promise<WebSocket> {
	if (ws?.readyState === WebSocket.OPEN) return Promise.resolve(ws);
	if (!ws && !connecting) void connect();
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const waiter: RelayOpenWaiter = {
		resolve,
		reject,
		timer: setTimeout(() => {
			relayOpenWaiters.delete(waiter);
			reject(new Error("Relay connection is not available."));
		}, 15_000),
	};
	relayOpenWaiters.add(waiter);
	return promise;
}
function waitForRelayReconnect(previous: WebSocket): Promise<WebSocket> {
	if (ws && ws !== previous && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const waiter: RelayReconnectWaiter = {
		previous,
		resolve,
		reject,
		timer: setTimeout(() => {
			relayReconnectWaiters.delete(waiter);
			reject(new Error("Relay listener changed, but the extension did not reconnect."));
		}, 15_000),
	};
	relayReconnectWaiters.add(waiter);
	return promise;
}

function sendTailnetAccessRequest(
	socket: WebSocket,
	enabled?: boolean,
): { response: Promise<TailnetAccessResult>; pending: PendingTailnetRequest } {
	if (ws !== socket || socket.readyState !== WebSocket.OPEN) {
		throw new Error("Relay connection is not available.");
	}
	const requestId = ++nextTailnetRequestId;
	const { promise, resolve, reject } = Promise.withResolvers<TailnetAccessResult>();
	const pending: PendingTailnetRequest = {
		resolve,
		reject,
		timer: setTimeout(() => {
			pendingTailnetRequests.delete(requestId);
			reject(new Error("Relay did not respond to the Tailnet access request."));
		}, 10_000),
	};
	pendingTailnetRequests.set(requestId, pending);
	const message: ExtToRelayMessage =
		enabled === undefined
			? { t: "tailnetAccessRequest", requestId }
			: { t: "tailnetAccessRequest", requestId, enabled };
	try {
		socket.send(JSON.stringify(message));
	} catch (error) {
		pendingTailnetRequests.delete(requestId);
		clearTimeout(pending.timer);
		reject(error instanceof Error ? error : new Error(String(error)));
	}
	return { response: promise, pending };
}

async function requestTailnetAccess(enabled?: boolean): Promise<TailnetAccessResult> {
	const socket = await waitForRelaySocket();
	const request = sendTailnetAccessRequest(socket, enabled);
	const result = await request.response;
	if (!result.rebindRequired) return result;
	const reconnectedSocket = await request.pending.reconnect;
	if (!reconnectedSocket) throw new Error("Relay did not restart its listener.");
	const confirmed = await sendTailnetAccessRequest(reconnectedSocket).response;
	if (enabled !== undefined && confirmed.enabled !== enabled) {
		return {
			...confirmed,
			ok: false,
			error: confirmed.error ?? "The relay could not apply the requested Tailnet access state.",
		};
	}
	return confirmed;
}

function rejectPendingTailnetRequests(error: Error): void {
	for (const [requestId, pending] of pendingTailnetRequests) {
		pendingTailnetRequests.delete(requestId);
		clearTimeout(pending.timer);
		pending.reject(error);
	}
}

function ensureInstanceId(): Promise<string> {
	identity ??= (async () => {
		const key = "relayInstanceId";
		const stored = await chrome.storage.local.get({ [key]: "" });
		const existing = stored[key];
		if (typeof existing === "string" && existing.length > 0) return existing;
		const id = crypto.randomUUID();
		await chrome.storage.local.set({ [key]: id });
		return id;
	})();
	return identity;
}

function post(message: ExtToRelayMessage): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

const workspace = new Workspace(chrome, post);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
	if (
		!message ||
		typeof message !== "object" ||
		!("op" in message) ||
		sender.url !== chrome.runtime.getURL("options.html")
	)
		return false;
	if (message.op === "createWorkspaceTab") {
		void workspace.runRpc({ op: "createTab", url: "about:blank" }).then(
			() => reply({ ok: true }),
			(error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
		);
		return true;
	}
	if (message.op === "getTailnetAccess") {
		void requestTailnetAccess().then(
			result => reply({ ...result }),
			(error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
		);
		return true;
	}
	if (message.op === "setTailnetAccess" && "enabled" in message && typeof message.enabled === "boolean") {
		void requestTailnetAccess(message.enabled).then(
			result => reply({ ...result }),
			(error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
		);
		return true;
	}
	return false;
});

async function setBadge(connected: boolean): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
		await chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#8b8b8b" });
	} catch {
		// Cosmetic failures must not prevent reconnecting.
	}
}

function handleRelayMessage(socket: WebSocket, raw: string): void {
	let message: RelayToExtMessage;
	try {
		message = JSON.parse(raw) as RelayToExtMessage;
	} catch {
		return;
	}
	if (message.t === "tailnetAccessResult") {
		const pending = pendingTailnetRequests.get(message.requestId);
		if (!pending) return;
		pendingTailnetRequests.delete(message.requestId);
		clearTimeout(pending.timer);
		if (message.rebindRequired) {
			pending.reconnect = waitForRelayReconnect(socket);
			post({ t: "tailnetAccessAck", requestId: message.requestId });
		}
		pending.resolve(message);
		return;
	}
	if (message.t !== "rpc") return;
	void workspace.runRpc(message).then(
		result => {
			if (ws === socket) post({ t: "rpcResult", id: message.id, ok: true, result });
		},
		(error: unknown) => {
			if (ws === socket)
				post({
					t: "rpcResult",
					id: message.id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
		},
	);
}

function scheduleReconnect(): void {
	if (reconnectTimer !== null) return;
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		void connect();
	}, delay);
}

async function connect(): Promise<void> {
	if (connecting || ws) return;
	connecting = true;
	try {
		await cleanup;
		await workspace.ready;
		const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
		const configuredPort = Number(stored.port);
		const port =
			Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
				? configuredPort
				: DEFAULT_PORT;
		const token = typeof stored.token === "string" ? stored.token : "";
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ext${token ? `?token=${encodeURIComponent(token)}` : ""}`);
		ws = socket;
		socket.onopen = () => {
			reconnectDelay = RECONNECT_MIN_MS;
			void setBadge(true);
			for (const waiter of relayOpenWaiters) {
				clearTimeout(waiter.timer);
				relayOpenWaiters.delete(waiter);
				waiter.resolve(socket);
			}
			for (const waiter of relayReconnectWaiters) {
				if (waiter.previous === socket) continue;
				clearTimeout(waiter.timer);
				relayReconnectWaiters.delete(waiter);
				waiter.resolve(socket);
			}
			void ensureInstanceId()
				.then(id => workspace.hello(id, navigator.userAgent))
				.then(hello => {
					if (ws === socket) post(hello);
				})
				.catch(() => socket.close());
			clearInterval(pingTimer ?? undefined);
			pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
		};
		socket.onmessage = event => {
			if (ws === socket && typeof event.data === "string") handleRelayMessage(socket, event.data);
		};
		socket.onclose = () => {
			if (ws !== socket) return;
			ws = null;
			if (pingTimer !== null) {
				clearInterval(pingTimer);
				pingTimer = null;
			}
			void setBadge(false);
			cleanup = workspace.releaseAll();
			scheduleReconnect();
			rejectPendingTailnetRequests(new Error("Relay connection closed."));
		};
		socket.onerror = () => socket.close();
	} catch {
		scheduleReconnect();
	} finally {
		connecting = false;
	}
}

void chrome.alarms.create("omp-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === "omp-relay-keepalive") void connect();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;
	const settingsChanged = [changes.port, changes.token].some(change => change && change.oldValue !== change.newValue);
	if (!settingsChanged) return;
	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (ws) ws.close();
	else void connect();
});
chrome.action.onClicked.addListener(() => {
	void chrome.runtime.openOptionsPage();
});
chrome.runtime.onInstalled.addListener(() => {
	void connect();
});
chrome.runtime.onStartup.addListener(() => {
	void connect();
});
void connect();
