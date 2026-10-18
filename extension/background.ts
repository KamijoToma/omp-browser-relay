/** MV3 transport; workspace.ts enforces dedicated-window ownership on every RPC. */
import type { ExtToRelayMessage, RelayToExtMessage } from "../src/protocol";
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
		message.op !== "createWorkspaceTab" ||
		sender.url !== chrome.runtime.getURL("options.html")
	)
		return false;
	void workspace.runRpc({ op: "createTab", url: "about:blank" }).then(
		() => reply({ ok: true }),
		(error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
	);
	return true;
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
