/**
 * CDP façade over `chrome.debugger`.
 *
 * Puppeteer clients (the omp browser tool: one supervisor connection plus one
 * per tab worker) connect to this bridge as if it were Chrome's browser
 * debugging endpoint. Chrome only allows a single debugger attachment per tab,
 * so the bridge owns ONE `chrome.debugger` attachment per tab (via the
 * extension) and multiplexes every downstream connection over it with minted
 * per-connection session ids.
 *
 * Emulated surface (other page-local commands go to `chrome.debugger`;
 * browser-global commands and unscoped Target commands are rejected):
 * - the browser target (`/json/version` handshake, `Browser.getVersion`)
 * - the `Target.*` domain, including puppeteer's tab → page auto-attach
 *   hierarchy (see puppeteer-core `cdp/ExtensionTransport.ts`, the reference
 *   implementation for this emulation)
 *
 * Session id namespaces seen by a downstream connection:
 * - minted tab pseudo-sessions (`ST<tab>.<conn>.<n>`) — Target emulation only
 * - minted page pseudo-sessions (`SP<tab>.<conn>.<n>`) — forwarded to the
 *   tab's root debugger session
 * - namespaced child session ids (`SC<instance>.<tab>.<Chrome session>`) — OOPIFs
 *   and workers; translated to Chrome's real ids only on the extension leg
 */
import { createHash } from "node:crypto";
import { version } from "../package.json";
import {
	DISCARDED_TABS_PROTOCOL_VERSION,
	isWorkspaceCleanupCommand,
	RELAY_CAPABILITIES,
	RELAY_PROTOCOL_VERSION,
	type ExtToRelayMessage,
	type RelayRpcRequest,
	type RelayToExtMessage,
	type TabSnapshot,
} from "./protocol";

/** Transport-agnostic websocket surface the bridge writes to. */
export interface RelaySocket {
	send(text: string): void;
	close(): void;
}

interface CdpCommand {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

/**
 * Per-pseudo-session Runtime domain state.
 * - `default`: never toggled Runtime — still receives the relay's legacy
 *   root-event fan-out, so omp's own patched-puppeteer client (which
 *   pull-acquires contexts and never sends `Runtime.enable`) keeps getting
 *   `Runtime.executionContextCreated`.
 * - `enabled`: ran `Runtime.enable`; gets the existing-context replay.
 * - `disabled`: explicitly ran `Runtime.disable`; silenced until it re-enables.
 */
type RuntimeState = "default" | "enabled" | "disabled";

interface SessionRef {
	kind: "tab" | "page";
	/** Registry key of the owning tab (`<instance code>:<chrome tabId>`). */
	tabKey: string;
	tabId: number;
	runtimeState: RuntimeState;
	/** Context ids already announced to this pseudo-session. */
	readonly runtimeContexts: Set<number>;
	/** In-flight `Runtime.enable` for this session; duplicates await it. */
	runtimeEnabling: Promise<void> | null;
	/** Monotonic ownership token for enable rollback and replay. */
	runtimeEpoch: number;
}

interface TargetInfo {
	targetId: string;
	type: "tab" | "page" | "browser";
	title: string;
	url: string;
	attached: boolean;
	canAccessOpener: boolean;
}

class CdpConnection {
	discover = false;
	autoAttach = false;
	/** Minted pseudo-sessions owned by this connection. */
	readonly sessions = new Map<string, SessionRef>();
	/** Browser pseudo-sessions have no owning workspace tab. */
	readonly browserSessions = new Set<string>();
	affineInstanceId: string | null = null;

	constructor(
		readonly id: number,
		readonly socket: RelaySocket,
	) {}

	sessionsForTab(tabKey: string, kind?: "tab" | "page"): string[] {
		const out: string[] = [];
		for (const [sessionId, ref] of this.sessions) {
			if (ref.tabKey === tabKey && (!kind || ref.kind === kind)) out.push(sessionId);
		}
		return out;
	}
}

/** Transport replacement is retryable and must not permanently ban a tab. */
class ExtensionReplacedError extends Error {}

/** A connected extension browser instance; one per browser/profile. */
interface ExtInstance {
	instanceId: string;
	/** Stable short code derived from the instance id; names target ids (`TAB<code>.<tabId>`). */
	code: string;
	browserSession: string;
	socket: RelaySocket | null;
	info: { userAgent: string; browserVersion: string } | null;
	workspaceWindowId: number | null;
}

/** Deterministic per-instance code for target ids: stable across relay restarts. */
function instanceCode(instanceId: string, browserSession: string): string {
	return createHash("sha256").update(`${instanceId}:${browserSession}`).digest("base64url").slice(0, 8);
}

function tabKeyOf(extCode: string, tabId: number): string {
	return `${extCode}:${tabId}`;
}

function tabTargetIdFromKey(key: string): string {
	return `TAB${key.replace(":", ".")}`;
}

function pageTargetIdFromKey(key: string): string {
	return `PAGE${key.replace(":", ".")}`;
}

function parseTargetId(targetId: string): { key: string; kind: "tab" | "page" } | null {
	const match = /^(TAB|PAGE)([^.]+)\.(\d+)$/.exec(targetId);
	if (!match) return null;
	const kind: "tab" | "page" = match[1] === "TAB" ? "tab" : "page";
	return { key: `${match[2]}:${match[3]}`, kind };
}

function isTabId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isWindowId(value: unknown): value is number | null {
	return value === null || isTabId(value);
}

function isTabSnapshot(value: unknown): value is TabSnapshot {
	if (!value || typeof value !== "object") return false;
	return (
		"tabId" in value &&
		isTabId(value.tabId) &&
		"windowId" in value &&
		isTabId(value.windowId) &&
		"url" in value &&
		typeof value.url === "string" &&
		"title" in value &&
		typeof value.title === "string" &&
		"active" in value &&
		typeof value.active === "boolean" &&
		"discarded" in value &&
		typeof value.discarded === "boolean"
	);
}

class TabState {
	/** Assigned in the constructor body from the owning instance. */
	readonly tabKey: string;
	url: string;
	title: string;
	active: boolean;
	discarded: boolean;
	windowId: number;
	/** Whether `chrome.debugger` is currently attached to this tab. */
	attached = false;
	/** Set when attach failed or the user cancelled the debugger; cleared on navigation. */
	banned = false;
	/** Whether targets for this tab were announced to discovering connections. */
	announced = false;
	attaching: Promise<boolean> | null = null;
	/** Relay-initiated detach in flight; reattach serializes behind it. */
	detaching: Promise<void> | null = null;
	/** A successful attach completed after the most recently requested relay detach. */
	reattachedAfterDetach = false;
	/** Real Chrome session ids (OOPIF/worker children) living under this tab's root session. */
	readonly realSessions = new Set<string>();
	/** Live execution contexts from the shared root debugger session. */
	readonly runtimeContexts = new Map<number, Record<string, unknown>>();
	/** Whether the shared root Runtime domain has been enabled by the bridge. */
	rootRuntimeEnabled = false;
	rootRuntimeEnabling: Promise<void> | null = null;
	/** Invalidates an in-flight Runtime enable when the debugger detaches. */
	runtimeGeneration = 0;

	constructor(
		readonly instanceId: string,
		readonly extCode: string,
		readonly tabId: number,
		snap: TabSnapshot,
	) {
		this.tabKey = tabKeyOf(extCode, tabId);
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.discarded = snap.discarded;
		this.windowId = snap.windowId;
	}

	update(snap: TabSnapshot): void {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.discarded = snap.discarded;
		this.windowId = snap.windowId;
	}
}

/** URLs `chrome.debugger` cannot attach to; hidden from downstream discovery entirely. */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i;

const RPC_TIMEOUT_MS = 20_000;
const BROWSER_TARGET_ID = "relay-browser";
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;

/**
 * Multiplexing CDP bridge between downstream puppeteer connections and the
 * relay extension. One instance per relay server; all state lives here so an
 * extension service-worker restart only has to re-handshake.
 */
export class RelayBridge {
	/** Tab registries keyed by `<instance code>:<chrome tabId>`; one namespace per browser instance. */
	#tabs = new Map<string, TabState>();
	#conns = new Map<number, CdpConnection>();
	#connSeq = 0;
	#sessionSeq = 0;
	#rpcSeq = 0;
	/** Connected extension browser instances, keyed by stable instance id. */
	#instances = new Map<string, ExtInstance>();
	#socketInstance = new Map<RelaySocket, string>();
	/** Instance whose hello ran last: answers browser-wide requests and owns created tabs. */
	#lastHelloInstance: string | null = null;
	#extensionSeen = false;
	#extensionGoneSince: number | null = null;
	#pendingRpc = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (err: Error) => void;
			timer: NodeJS.Timeout;
			tabKey?: string;
			lifecycleWindowId?: number;
		}
	>();
	/** Downstream child session id → browser-scoped Chrome session and tab. */
	#realSessionTabs = new Map<string, { tabKey: string; sessionId: string }>();
	#log: (message: string, data?: Record<string, unknown>) => void;

	constructor(
		opts: {
			log?: (message: string, data?: Record<string, unknown>) => void;
		} = {},
	) {
		this.#log = opts.log ?? (() => {});
	}

	/** True once the extension has completed its hello handshake. */
	get ready(): boolean {
		for (const inst of this.#instances.values()) {
			if (inst.socket && inst.info) return true;
		}
		return false;
	}

	/** The instance whose hello ran last (browser-wide requests route there). */
	#lastHello(): ExtInstance | undefined {
		if (this.#lastHelloInstance) {
			const inst = this.#instances.get(this.#lastHelloInstance);
			if (inst?.socket) return inst;
		}
		for (const inst of this.#instances.values()) {
			if (inst.socket) return inst;
		}
		return undefined;
	}

	/** True after the first hello, and stays true: separates a reaped service worker from an absent extension. */
	get extensionSeen(): boolean {
		return this.#extensionSeen;
	}

	get cdpClientCount(): number {
		return this.#conns.size;
	}

	get extensionGoneForMs(): number | null {
		return this.#extensionGoneSince === null ? null : Date.now() - this.#extensionGoneSince;
	}

	/** Honest implementation identity; upstream leaves non-OMP version strings to their owner. */
	discoveryStatus(): Record<string, string | number> {
		return {
			ompRelayVersion: `omp-browser-relay/${version}`,
			ompRelayDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
			ompExtensionDiscardedTabsProtocol: String(this.ready ? DISCARDED_TABS_PROTOCOL_VERSION : 0),
			ompRelayCdpClients: this.#conns.size,
		};
	}

	/** Payload for `GET /json/version`. */
	versionInfo(wsUrl: string): Record<string, unknown> {
		const info = this.#lastHello()?.info;
		const ua = info?.userAgent ?? "";
		return {
			Browser: info?.browserVersion ?? "Chrome/unknown",
			"Protocol-Version": "1.3",
			"User-Agent": ua,
			"V8-Version": "",
			"WebKit-Version": "",
			webSocketDebuggerUrl: wsUrl,
			ompRelay: RELAY_CAPABILITIES,
			...this.discoveryStatus(),
		};
	}

	/** Payload for `GET /json/list` (debugging aid; per-target endpoints are not served). */
	listTargets(): Array<Record<string, string>> {
		const out: Array<Record<string, string>> = [];
		for (const tab of this.#tabs.values()) {
			if (!this.#eligible(tab)) continue;
			out.push({
				id: pageTargetIdFromKey(tab.tabKey),
				type: "page",
				title: tab.title,
				url: tab.url,
				active: String(tab.active),
				discarded: String(tab.discarded),
			});
		}
		return out;
	}

	// ---- extension lifecycle -------------------------------------------------

	#rejectPendingExtensionRpcs(instanceId: string, error: Error, closingWindowId?: number): void {
		const prefix = `${instanceId}:`;
		for (const [key, pending] of this.#pendingRpc) {
			if (!key.startsWith(prefix)) continue;
			if (closingWindowId !== undefined && pending.lifecycleWindowId === closingWindowId) continue;
			clearTimeout(pending.timer);
			pending.reject(error);
			this.#pendingRpc.delete(key);
		}
	}

	/** A new extension socket connected; its hello assigns (or reuses) a browser instance. */
	extConnected(_socket: RelaySocket): void {
		this.#log("extension socket connected");
	}

	extClosed(socket: RelaySocket): void {
		const instanceId = this.#socketInstance.get(socket);
		if (instanceId === undefined) return;
		this.#socketInstance.delete(socket);
		const inst = this.#instances.get(instanceId);
		if (!inst || inst.socket !== socket) return;
		inst.socket = null;
		if (!this.ready && this.#extensionSeen) this.#extensionGoneSince ??= Date.now();
		this.#rejectPendingExtensionRpcs(instanceId, new Error("relay extension disconnected"));
		// Keep the instance's tabs listed (the browser may reconnect), but drop
		// debugger state: the attachment died with the service worker.
		for (const tab of this.#tabs.values()) {
			if (tab.instanceId !== instanceId) continue;
			tab.attached = false;
			tab.attaching = null;
			this.#resetRuntime(tab);
		}
	}

	#setWorkspace(inst: ExtInstance, windowId: number | null): void {
		const previousWindowId = inst.workspaceWindowId;
		const changed = previousWindowId !== windowId;
		inst.workspaceWindowId = windowId;
		// Provisioning an absent workspace must complete its in-flight createTab RPC.
		if (changed && previousWindowId !== null) {
			this.#rejectPendingExtensionRpcs(
				inst.instanceId,
				new ExtensionReplacedError("Agent workspace changed"),
				windowId === null ? previousWindowId : undefined,
			);
		}
		for (const tab of this.#tabs.values()) {
			if (tab.instanceId !== inst.instanceId) continue;
			if (windowId === null || tab.windowId !== windowId) {
				this.#onTabRemoved(tab.tabKey);
			}
		}
	}

	extMessage(socket: RelaySocket, raw: string): void {
		let msg: ExtToRelayMessage;
		try {
			msg = JSON.parse(raw) as ExtToRelayMessage;
		} catch {
			this.#log("dropping malformed extension message");
			return;
		}
		if (!msg || typeof msg !== "object") return;
		if (msg.t === "hello") {
			this.#onHello(socket, msg);
			return;
		}
		const instanceId = this.#socketInstance.get(socket);
		if (instanceId === undefined) return;
		const inst = this.#instances.get(instanceId);
		if (!inst || inst.socket !== socket) return;
		switch (msg.t) {
			case "workspace":
				if (!isWindowId(msg.windowId)) return;
				this.#setWorkspace(inst, msg.windowId);
				return;
			case "rpcResult": {
				const key = `${instanceId}:${msg.id}`;
				const pending = this.#pendingRpc.get(key);
				if (!pending) return;
				this.#pendingRpc.delete(key);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "extension rpc failed"));
				return;
			}
			case "cdpEvent":
				this.#onCdpEvent(tabKeyOf(inst.code, msg.tabId), msg.sessionId, msg.method, msg.params);
				return;
			case "detached":
				this.#onTabDetached(tabKeyOf(inst.code, msg.tabId), msg.reason, msg.relayInitiated === true);
				return;
			case "tabCreated":
				this.#onTabUpsert(msg.tab, instanceId);
				return;
			case "tabUpdated":
				this.#onTabUpsert(msg.tab, instanceId);
				return;
			case "tabRemoved":
				this.#onTabRemoved(tabKeyOf(inst.code, msg.tabId));
				return;
			case "ping":
				socket.send(JSON.stringify({ t: "pong" } satisfies RelayToExtMessage));
				return;
		}
	}

	#onHello(socket: RelaySocket, msg: Extract<ExtToRelayMessage, { t: "hello" }>): void {
		if (
			msg.protocolVersion !== RELAY_PROTOCOL_VERSION ||
			typeof msg.instanceId !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(msg.instanceId) ||
			typeof msg.browserSession !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(msg.browserSession) ||
			msg.discardedTabsProtocol !== DISCARDED_TABS_PROTOCOL_VERSION ||
			typeof msg.userAgent !== "string" ||
			typeof msg.browserVersion !== "string" ||
			!isWindowId(msg.workspaceWindowId) ||
			!Array.isArray(msg.tabs) ||
			!msg.tabs.every(isTabSnapshot) ||
			!Array.isArray(msg.attachedTabIds) ||
			!msg.attachedTabIds.every(isTabId) ||
			(this.#socketInstance.has(socket) && this.#socketInstance.get(socket) !== msg.instanceId)
		) {
			this.#log("rejecting incompatible extension hello");
			this.extClosed(socket);
			socket.close();
			return;
		}
		const instanceId = msg.instanceId;
		let inst = this.#instances.get(instanceId);
		if (!inst) {
			inst = {
				instanceId,
				browserSession: msg.browserSession,
				code: instanceCode(instanceId, msg.browserSession),
				socket: null,
				info: null,
				workspaceWindowId: null,
			};
			this.#instances.set(instanceId, inst);
		} else if (inst.socket && inst.socket !== socket) {
			// Same browser reconnected (service-worker restart): retire the old
			// socket. Debugger-derived state dies with the old attachment, so
			// reset runtime state exactly like the old single-slot replace did;
			// the hello's attachedTabIds reconciliation runs right after.
			for (const tab of this.#tabs.values()) {
				if (tab.instanceId === instanceId) this.#resetRuntime(tab);
			}
			this.#rejectPendingExtensionRpcs(instanceId, new ExtensionReplacedError());
			this.#socketInstance.delete(inst.socket);
			inst.socket.close();
		}
		if (inst.browserSession !== msg.browserSession) {
			this.#rejectPendingExtensionRpcs(instanceId, new ExtensionReplacedError("Browser restarted"));
			for (const tab of this.#tabs.values()) {
				if (tab.instanceId === instanceId) this.#onTabRemoved(tab.tabKey);
			}
			inst.browserSession = msg.browserSession;
			inst.code = instanceCode(instanceId, msg.browserSession);
		}
		inst.socket = socket;
		this.#socketInstance.set(socket, instanceId);
		inst.info = { userAgent: msg.userAgent, browserVersion: msg.browserVersion };
		this.#setWorkspace(inst, msg.workspaceWindowId);
		this.#lastHelloInstance = instanceId;
		this.#extensionSeen = true;
		this.#extensionGoneSince = null;
		// The hello GC is scoped to this instance: another browser's tabs are
		// untouched, which is what lets Chrome and Edge share one relay.
		const seen = new Set<number>();
		const attachedNow = new Set(msg.attachedTabIds);
		for (const snap of msg.tabs) {
			seen.add(snap.tabId);
			this.#onTabUpsert(snap, instanceId, { silent: true });
		}
		for (const [key, tab] of this.#tabs) {
			if (tab.instanceId !== instanceId || seen.has(tab.tabId)) continue;
			this.#onTabRemoved(key);
		}
		for (const tab of this.#tabs.values()) {
			if (tab.instanceId !== instanceId) continue;
			tab.attached = attachedNow.has(tab.tabId);
			tab.attaching = null;
			// A service-worker restart can drop attachments while downstream
			// connections still hold sessions: restore them best-effort.
			if (tab.discarded) {
				this.#retractTab(tab);
				this.#detachIfUnheld(tab.tabKey);
				continue;
			}
			if (!tab.attached && this.#sessionHolders(tab.tabKey).length > 0) {
				void this.#ensureAttached(tab).then(ok => {
					if (!ok && tab.banned) this.#onTabDetached(tab.tabKey, "reattach_failed", false);
				});
			}
		}
		for (const snap of msg.tabs) this.#onTabUpsert(snap, instanceId);
		this.#log("extension connected", {
			instanceId,
			tabs: msg.tabs.length,
			version: msg.browserVersion,
		});
	}

	// ---- downstream (puppeteer) lifecycle -------------------------------------

	/** Register a downstream CDP websocket; returns the connection id. */
	cdpConnected(socket: RelaySocket): number {
		const conn = new CdpConnection(++this.#connSeq, socket);
		this.#conns.set(conn.id, conn);
		this.#log("cdp client connected", { conn: conn.id });
		return conn.id;
	}

	cdpClosed(connId: number): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		this.#conns.delete(connId);
		const touched = new Set<string>();
		for (const ref of conn.sessions.values()) touched.add(ref.tabKey);
		conn.sessions.clear();
		conn.browserSessions.clear();
		// Drop the debugger (and its infobar) from tabs nobody drives anymore.
		for (const tabKey of touched) this.#detachIfUnheld(tabKey);
		this.#log("cdp client closed", { conn: connId });
	}

	cdpMessage(connId: number, raw: string): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		let msg: CdpCommand;
		try {
			msg = JSON.parse(raw) as CdpCommand;
		} catch {
			return;
		}
		if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
		void this.#handleCdpCommand(conn, msg).catch(err => {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		});
	}

	// ---- command routing -------------------------------------------------------

	async #handleCdpCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		const sessionId = msg.sessionId;
		if (!sessionId) {
			await this.#handleBrowserCommand(conn, msg);
			return;
		}
		if (conn.browserSessions.has(sessionId)) {
			await this.#handleBrowserCommand(conn, msg);
			return;
		}
		const ref = conn.sessions.get(sessionId);
		if (ref) {
			const tab = this.#tabs.get(ref.tabKey);
			if (!tab || !this.#eligible(tab)) throw new Error("Workspace tab is unavailable");
		}
		if (ref?.kind === "tab") {
			this.#handleTabSessionCommand(conn, msg, ref);
			return;
		}
		if (ref?.kind === "page") {
			await this.#handlePageSessionCommand(conn, msg, sessionId, ref);
			return;
		}
		const child = this.#realSessionTabs.get(sessionId);
		if (child && conn.sessionsForTab(child.tabKey, "page").length > 0) {
			await this.#forwardToTab(conn, msg, child.tabKey, child.sessionId);
			return;
		}
		this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
	}

	async #handlePageSessionCommand(
		conn: CdpConnection,
		msg: CdpCommand,
		sessionId: string,
		ref: SessionRef,
	): Promise<void> {
		if (msg.method === "Runtime.disable") {
			ref.runtimeState = "disabled";
			ref.runtimeEpoch++;
			ref.runtimeContexts.clear();
			// Abandon any in-flight enable's ownership: a later enable starts fresh
			// rather than joining a cycle that predates this disable.
			ref.runtimeEnabling = null;
			this.#reply(conn, msg, {});
			return;
		}
		if (msg.method !== "Runtime.enable") {
			await this.#forwardToTab(conn, msg, ref.tabKey, undefined);
			return;
		}
		// A pipelined duplicate must await the in-flight enable, never ack early:
		// the root cycle may still fail, and success must trail the context replay.
		if (ref.runtimeEnabling) {
			await this.#awaitEnable(conn, msg, ref.runtimeEnabling);
			return;
		}
		const tab = this.#tabs.get(ref.tabKey);
		if (ref.runtimeState === "enabled" && tab?.rootRuntimeEnabled) {
			this.#reply(conn, msg, {});
			return;
		}
		const enabling = this.#enableSessionRuntime(conn, sessionId, ref);
		ref.runtimeEnabling = enabling;
		try {
			await this.#awaitEnable(conn, msg, enabling);
		} finally {
			if (ref.runtimeEnabling === enabling) ref.runtimeEnabling = null;
		}
	}

	/** Reply to one `Runtime.enable` command with the shared enable's outcome. */
	async #awaitEnable(conn: CdpConnection, msg: CdpCommand, enabling: Promise<void>): Promise<void> {
		try {
			await enabling;
			this.#reply(conn, msg, {});
		} catch (err) {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Drive the shared root `Runtime.enable` for a session and replay the live
	 * contexts to it. Rejects if the root cycle fails so every joined caller
	 * observes the failure instead of a spurious success.
	 */
	async #enableSessionRuntime(conn: CdpConnection, sessionId: string, ref: SessionRef): Promise<void> {
		const prev = ref.runtimeState;
		const epoch = ++ref.runtimeEpoch;
		ref.runtimeState = "enabled";
		const tab = this.#tabs.get(ref.tabKey);
		if (!tab) {
			ref.runtimeState = prev;
			throw new Error(`No tab ${ref.tabKey}`);
		}
		try {
			await this.#ensureRuntimeEnabled(tab);
			// A disable or newer enable may have taken ownership while the root
			// RPC was in flight; only the latest enable may replay or roll back.
			if (conn.sessions.get(sessionId) === ref && ref.runtimeEpoch === epoch && ref.runtimeState === "enabled") {
				this.#replayRuntimeContexts(conn, sessionId, ref, tab);
			}
		} catch (err) {
			if (ref.runtimeEpoch === epoch) {
				ref.runtimeState = prev;
				ref.runtimeContexts.clear();
			}
			throw err;
		}
	}

	async #ensureRuntimeEnabled(tab: TabState): Promise<void> {
		if (tab.rootRuntimeEnabled) return;
		if (tab.rootRuntimeEnabling) return await tab.rootRuntimeEnabling;

		const enabling = this.#cycleRuntime(tab);
		tab.rootRuntimeEnabling = enabling;
		const generation = tab.runtimeGeneration;
		try {
			await enabling;
			if (tab.runtimeGeneration === generation) tab.rootRuntimeEnabled = true;
		} finally {
			if (tab.rootRuntimeEnabling === enabling) tab.rootRuntimeEnabling = null;
		}
	}

	async #cycleRuntime(tab: TabState): Promise<void> {
		if (!tab.attached && !(await this.#ensureAttached(tab)))
			throw new Error("Workspace debugger attachment is unavailable");
		const inst = this.#instanceFor(tab);
		await this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.disable" }, inst);
		await this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.enable" }, inst);
	}

	#replayRuntimeContexts(conn: CdpConnection, sessionId: string, ref: SessionRef, tab: TabState): void {
		for (const [contextId, params] of tab.runtimeContexts) {
			if (ref.runtimeContexts.has(contextId)) continue;
			ref.runtimeContexts.add(contextId);
			conn.socket.send(JSON.stringify({ sessionId, method: "Runtime.executionContextCreated", params }));
		}
	}

	async #forwardToTab(
		conn: CdpConnection,
		msg: CdpCommand,
		tabKey: string,
		realSessionId: string | undefined,
	): Promise<void> {
		const tab = this.#tabs.get(tabKey);
		if (!tab) {
			this.#replyError(conn, msg, `No tab with key ${tabKey}`);
			return;
		}
		const cleanup = isWorkspaceCleanupCommand(msg.method, msg.params);
		if (!this.#eligible(tab)) throw new Error("Workspace tab is unavailable");
		if (msg.method === "OMP.claimTarget") {
			conn.affineInstanceId = tab.instanceId;
			this.#reply(conn, msg, {});
			return;
		}
		if (
			msg.method === "Target.createTarget" ||
			msg.method === "Target.closeTarget" ||
			msg.method === "Target.activateTarget"
		) {
			await this.#handleBrowserCommand(conn, msg, tab);
			return;
		}
		if (msg.method === "Emulation.setFocusEmulationEnabled") {
			if (realSessionId) throw new Error("Focus emulation must address the workspace page");
			if (typeof msg.params?.enabled !== "boolean") throw new Error("Focus emulation requires boolean enabled");
		}
		if (msg.method === "Page.bringToFront") {
			await this.#rpc({ op: "activateTab", tabId: tab.tabId }, this.#instanceFor(tab));
			this.#reply(conn, msg, {});
			return;
		}
		if (msg.method.startsWith("Browser.") || msg.method.startsWith("OMP.")) {
			throw new Error(`'${msg.method}' is not supported on a workspace page`);
		}
		let params = msg.params;
		// Visible shared pages use actual browser focus. Keep the stock CDP
		// request/response contract without enabling native focus emulation.
		if (msg.method === "Emulation.setFocusEmulationEnabled") params = { enabled: false };
		if (msg.method.startsWith("Target.")) {
			const child = msg.params?.sessionId;
			const childRef = typeof child === "string" ? this.#realSessionTabs.get(child) : undefined;
			const allowed =
				(msg.method === "Target.setAutoAttach" && msg.params?.flatten === true) ||
				(msg.method === "Target.detachFromTarget" && childRef?.tabKey === tabKey) ||
				(msg.method === "Target.getTargetInfo" && msg.params?.targetId === undefined);
			if (!allowed) throw new Error(`'${msg.method}' cannot address targets outside the workspace page`);
			if (msg.method === "Target.detachFromTarget" && childRef)
				params = { ...params, sessionId: childRef.sessionId };
		}
		if (!cleanup && !tab.attached && !(await this.#ensureAttached(tab))) {
			throw new Error("Workspace debugger attachment is unavailable");
		}
		const inst = this.#instances.get(tab.instanceId);
		if (!inst || !inst.socket) {
			this.#replyError(conn, msg, "relay extension is not connected");
			return;
		}
		try {
			const result = await this.#rpc(
				{
					op: "send",
					tabId: tab.tabId,
					sessionId: realSessionId,
					method: msg.method,
					params,
				},
				inst,
			);
			this.#reply(conn, msg, (result as Record<string, unknown> | undefined) ?? {});
		} catch (err) {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	/** Tab pseudo-sessions only exist to satisfy puppeteer's Target hierarchy. */
	#handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: SessionRef): void {
		switch (msg.method) {
			case "Target.setAutoAttach": {
				const tab = this.#tabs.get(ref.tabKey);
				if (!tab) {
					this.#replyError(conn, msg, `Tab ${ref.tabKey} is gone`);
					return;
				}
				// Emit before replying: puppeteer's TargetManager counts page
				// children attached before the setAutoAttach response resolves.
				const pageSession = this.#mintSession(conn, "page", tab);
				this.#emit(
					conn,
					"Target.attachedToTarget",
					{
						sessionId: pageSession,
						targetInfo: this.#pageInfo(tab, true),
						waitingForDebugger: false,
					},
					msg.sessionId,
				);
				this.#reply(conn, msg, {});
				return;
			}
			case "Runtime.runIfWaitingForDebugger":
				this.#reply(conn, msg, {});
				return;
			case "Target.detachFromTarget": {
				const child = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (child) this.#releaseSession(conn, child, msg.sessionId);
				this.#reply(conn, msg, {});
				return;
			}
			default:
				this.#replyError(conn, msg, `'${msg.method}' is not supported on a tab target`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	async #handleBrowserCommand(conn: CdpConnection, msg: CdpCommand, near?: TabState): Promise<void> {
		if (msg.sessionId && (msg.method === "Target.setAutoAttach" || msg.method === "Target.setDiscoverTargets")) {
			this.#replyError(
				conn,
				msg,
				`'${msg.method}' is not supported on a browser session`,
				CDP_ERROR_METHOD_NOT_FOUND,
			);
			return;
		}
		switch (msg.method) {
			case "Browser.getVersion": {
				this.#reply(conn, msg, {
					protocolVersion: "1.3",
					product: this.#lastHello()?.info?.browserVersion ?? "Chrome/unknown",
					revision: "",
					userAgent: this.#lastHello()?.info?.userAgent ?? "",
					jsVersion: "",
				});
				return;
			}
			case "Target.getBrowserContexts":
				this.#reply(conn, msg, { browserContextIds: [] });
				return;
			case "Target.getTargets": {
				const targetInfos: TargetInfo[] = [];
				for (const tab of this.#tabs.values()) {
					if (this.#eligible(tab) && !tab.discarded) targetInfos.push(this.#pageInfo(tab, tab.attached));
				}
				this.#reply(conn, msg, { targetInfos });
				return;
			}
			case "Target.setDiscoverTargets": {
				conn.discover = true;
				this.#emit(conn, "Target.targetCreated", { targetInfo: this.#browserInfo() });
				for (const tab of this.#tabs.values()) {
					if (!this.#eligible(tab) || tab.discarded) continue;
					tab.announced = true;
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.setAutoAttach": {
				conn.autoAttach = true;
				const tabs = [...this.#tabs.values()].filter(tab => this.#eligible(tab) && !tab.discarded);
				await Promise.all(tabs.map(tab => this.#ensureAttached(tab)));
				for (const tab of tabs) {
					if (!tab.attached || tab.discarded || !this.#eligible(tab)) {
						// Attach failed (DevTools open, another debugger, …): retract
						// the target so puppeteer's init never waits on it.
						this.#retractTab(tab);
						continue;
					}
					this.#emitTabAttached(conn, tab);
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.attachToTarget": {
				if (msg.params?.targetId === BROWSER_TARGET_ID) {
					const sessionId = `SB${conn.id}.${++this.#sessionSeq}`;
					conn.browserSessions.add(sessionId);
					this.#emit(
						conn,
						"Target.attachedToTarget",
						{
							sessionId,
							targetInfo: this.#browserInfo(),
							waitingForDebugger: false,
						},
						msg.sessionId,
					);
					this.#reply(conn, msg, { sessionId });
					return;
				}
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				const tab = parsed ? this.#tabs.get(parsed.key) : undefined;
				if (!parsed || !tab) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				if (!(await this.#ensureAttached(tab)) || !this.#eligible(tab)) {
					this.#replyError(conn, msg, `Cannot attach to tab ${tab.tabKey} (${tab.url})`);
					return;
				}
				const sessionId = this.#mintSession(conn, parsed.kind, tab);
				const info = parsed.kind === "tab" ? this.#tabInfo(tab, true) : this.#pageInfo(tab, true);
				this.#emit(
					conn,
					"Target.attachedToTarget",
					{ sessionId, targetInfo: info, waitingForDebugger: false },
					msg.sessionId,
				);
				this.#reply(conn, msg, { sessionId });
				return;
			}
			case "Target.detachFromTarget": {
				const sessionId = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (sessionId) this.#releaseSession(conn, sessionId, msg.sessionId);
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.createTarget": {
				const url =
					typeof msg.params?.url === "string" && msg.params.url.length > 0 ? msg.params.url : "about:blank";
				const inst = this.#instanceForNewTab(conn, msg.params?.nearTargetId, near);
				if (!inst || !inst.socket) {
					this.#replyError(conn, msg, "relay extension is not connected");
					return;
				}
				const result = (await this.#rpc({ op: "createTab", url }, inst)) as { tab: TabSnapshot };
				this.#onTabUpsert(result.tab, inst.instanceId);
				const createdKey = tabKeyOf(inst.code, result.tab.tabId);
				if (!this.#tabs.has(createdKey)) throw new Error("Extension created a tab outside its workspace");
				conn.affineInstanceId = inst.instanceId;
				this.#reply(conn, msg, { targetId: pageTargetIdFromKey(createdKey) });
				return;
			}
			case "Target.closeTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (!parsed) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				const removedTab = this.#tabs.get(parsed.key);
				if (!removedTab) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				await this.#rpc({ op: "removeTab", tabId: removedTab.tabId }, this.#instanceFor(removedTab));
				this.#reply(conn, msg, { success: true });
				return;
			}
			case "Target.activateTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				const activatedTab = parsed ? this.#tabs.get(parsed.key) : undefined;
				if (!activatedTab || !this.#eligible(activatedTab)) throw new Error("Workspace target is unavailable");
				await this.#rpc({ op: "activateTab", tabId: activatedTab.tabId }, this.#instanceFor(activatedTab));
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.getTargetInfo": {
				const raw = msg.params?.targetId;
				if (raw === undefined || raw === BROWSER_TARGET_ID) {
					this.#reply(conn, msg, { targetInfo: this.#browserInfo() });
					return;
				}
				const parsed = typeof raw === "string" ? parseTargetId(raw) : null;
				const tab = parsed ? this.#tabs.get(parsed.key) : undefined;
				if (parsed && tab && this.#eligible(tab)) {
					const info =
						parsed.kind === "tab" ? this.#tabInfo(tab, tab.attached) : this.#pageInfo(tab, tab.attached);
					this.#reply(conn, msg, { targetInfo: info });
					return;
				}
				this.#replyError(conn, msg, `No target with id ${String(raw)}`);
				return;
			}
			case "Browser.close":
				this.#replyError(conn, msg, "Closing the user's browser is not supported by the browser relay");
				return;
			case "Browser.setDownloadBehavior":
				this.#replyError(conn, msg, "Browser-global download behavior is not supported by the browser relay");
				return;
			case "Target.createBrowserContext":
				this.#replyError(conn, msg, "Browser contexts are not supported by the browser relay");
				return;
			default:
				this.#replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	// ---- extension events -------------------------------------------------------

	#onCdpEvent(
		tabKey: string,
		sourceSessionId: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab || !this.#instances.get(tab.instanceId)?.socket) return;
		if (sourceSessionId && !tab.realSessions.has(sourceSessionId)) return;
		// Track real child sessions so downstream commands can route back.
		if (method === "Target.attachedToTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.add(child);
				this.#realSessionTabs.set(`SC${tab.extCode}.${tab.tabId}.${child}`, { tabKey, sessionId: child });
				params = { ...params, sessionId: `SC${tab.extCode}.${tab.tabId}.${child}` };
			}
		} else if (method === "Target.detachedFromTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.delete(child);
				this.#realSessionTabs.delete(`SC${tab.extCode}.${tab.tabId}.${child}`);
				params = { ...params, sessionId: `SC${tab.extCode}.${tab.tabId}.${child}` };
			}
		}
		if (sourceSessionId) {
			// Event from a real child session: pass through verbatim to every
			// connection that observes this tab.
			const payload = JSON.stringify({
				sessionId: `SC${tab.extCode}.${tab.tabId}.${sourceSessionId}`,
				method,
				params,
			});
			for (const conn of this.#conns.values()) {
				if (conn.sessionsForTab(tabKey, "page").length > 0) conn.socket.send(payload);
			}
			return;
		}
		if (method.startsWith("Runtime.")) {
			const createdContext = method === "Runtime.executionContextCreated" ? params?.context : undefined;
			const createdContextId =
				createdContext &&
				typeof createdContext === "object" &&
				"id" in createdContext &&
				typeof createdContext.id === "number"
					? createdContext.id
					: undefined;
			const destroyedContextId =
				method === "Runtime.executionContextDestroyed" && typeof params?.executionContextId === "number"
					? params.executionContextId
					: undefined;
			if (createdContextId !== undefined && params) tab.runtimeContexts.set(createdContextId, params);
			if (destroyedContextId !== undefined) tab.runtimeContexts.delete(destroyedContextId);
			if (method === "Runtime.executionContextsCleared") tab.runtimeContexts.clear();

			for (const conn of this.#conns.values()) {
				for (const [pageSession, ref] of conn.sessions) {
					if (ref.kind !== "page" || ref.tabKey !== tabKey) continue;
					if (destroyedContextId !== undefined) ref.runtimeContexts.delete(destroyedContextId);
					if (method === "Runtime.executionContextsCleared") ref.runtimeContexts.clear();
					// `default` sessions never enabled Runtime but still get the
					// legacy fan-out; only an explicit `Runtime.disable` silences one.
					if (ref.runtimeState === "disabled") continue;
					if (createdContextId !== undefined) {
						if (ref.runtimeContexts.has(createdContextId)) continue;
						ref.runtimeContexts.add(createdContextId);
					}
					conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
				}
			}
			return;
		}
		// Other root-session events fan out once per minted page session.
		for (const conn of this.#conns.values()) {
			for (const pageSession of conn.sessionsForTab(tabKey, "page")) {
				conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
			}
		}
	}

	#onTabDetached(tabKey: string, reason: string, relayInitiated: boolean): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab) return;
		// Explicit source attribution comes from the extension that executed
		// chrome.debugger.detach, so socket replacement cannot confuse this
		// with a user cancellation or mutate an unrelated attach promise.
		if (relayInitiated) {
			// A replacement hello can observe the old attachment before the
			// pending detach completes. Reconcile that stale snapshot unless a
			// later attach has already superseded this detach.
			if (!tab.reattachedAfterDetach) tab.attached = false;
			return;
		}
		this.#log("tab detached", { tabKey, reason });
		for (const conn of this.#conns.values()) {
			for (const sessionId of conn.sessionsForTab(tabKey, "page"))
				this.#emit(conn, "OMP.debuggerDetached", { reason }, sessionId);
		}
		tab.attached = false;
		tab.attaching = null;
		this.#resetRuntime(tab);
		tab.banned = true;
		this.#retractTab(tab);
	}

	#onTabRemoved(tabKey: string): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab) return;
		this.#retractTab(tab);
		this.#resetRuntime(tab);
		for (const [key, pending] of this.#pendingRpc) {
			if (pending.tabKey !== tabKey) continue;
			clearTimeout(pending.timer);
			pending.reject(new ExtensionReplacedError("Tab left the agent workspace"));
			this.#pendingRpc.delete(key);
		}
		this.#tabs.delete(tabKey);
	}

	#onTabUpsert(snap: TabSnapshot, instanceId: string, opts: { silent?: boolean } = {}): void {
		const inst = this.#instances.get(instanceId);
		if (!isTabSnapshot(snap)) return;
		if (!inst) return;
		const key = tabKeyOf(inst.code, snap.tabId);
		if (inst.workspaceWindowId === null || snap.windowId !== inst.workspaceWindowId) {
			this.#onTabRemoved(key);
			return;
		}
		let tab = this.#tabs.get(key);
		if (!tab) {
			tab = new TabState(instanceId, inst.code, snap.tabId, snap);
			this.#tabs.set(key, tab);
		} else {
			if (tab.url !== snap.url || (tab.discarded && !snap.discarded)) tab.banned = false;
			tab.update(snap);
		}
		if (opts.silent) return;
		if (tab.discarded) {
			for (const [pendingKey, pending] of this.#pendingRpc) {
				if (pending.tabKey !== key) continue;
				clearTimeout(pending.timer);
				pending.reject(new ExtensionReplacedError("Chrome discarded the workspace tab"));
				this.#pendingRpc.delete(pendingKey);
			}
			this.#retractTab(tab);
			this.#detachIfUnheld(key);
			return;
		}
		const eligible = this.#eligible(tab);
		if (eligible && !tab.announced) {
			tab.announced = true;
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
				this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
			}
			for (const conn of this.#conns.values()) {
				if (!conn.autoAttach) continue;
				void this.#ensureAttached(tab).then(ok => {
					if (ok) this.#emitTabAttached(conn, tab);
				});
			}
			return;
		}
		if (!eligible && tab.announced) {
			this.#retractTab(tab);
			return;
		}
		if (eligible && tab.announced) {
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#tabInfo(tab, tab.attached) });
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#pageInfo(tab, tab.attached) });
			}
		}
	}

	/** Tear a tab out of every downstream connection (closed, detached, or now ineligible). */
	#retractTab(tab: TabState): void {
		for (const realSession of tab.realSessions)
			this.#realSessionTabs.delete(`SC${tab.extCode}.${tab.tabId}.${realSession}`);
		tab.realSessions.clear();
		for (const conn of this.#conns.values()) {
			const tabSessions = conn.sessionsForTab(tab.tabKey, "tab");
			for (const pageSession of conn.sessionsForTab(tab.tabKey, "page")) {
				conn.sessions.delete(pageSession);
				this.#emit(
					conn,
					"Target.detachedFromTarget",
					{ sessionId: pageSession, targetId: pageTargetIdFromKey(tab.tabKey) },
					tabSessions[0],
				);
			}
			for (const tabSession of tabSessions) {
				conn.sessions.delete(tabSession);
				this.#emit(conn, "Target.detachedFromTarget", {
					sessionId: tabSession,
					targetId: tabTargetIdFromKey(tab.tabKey),
				});
			}
			if (conn.discover && tab.announced) {
				this.#emit(conn, "Target.targetDestroyed", { targetId: pageTargetIdFromKey(tab.tabKey) });
				this.#emit(conn, "Target.targetDestroyed", { targetId: tabTargetIdFromKey(tab.tabKey) });
			}
		}
		tab.announced = false;
	}

	// ---- session + attach bookkeeping --------------------------------------------

	#mintSession(conn: CdpConnection, kind: "tab" | "page", tab: TabState): string {
		const sessionId = `S${kind === "tab" ? "T" : "P"}${tab.tabId}.${conn.id}.${++this.#sessionSeq}`;
		conn.sessions.set(sessionId, {
			kind,
			tabKey: tab.tabKey,
			tabId: tab.tabId,
			runtimeState: "default",
			runtimeContexts: new Set(),
			runtimeEnabling: null,
			runtimeEpoch: 0,
		});
		return sessionId;
	}

	#releaseSession(conn: CdpConnection, sessionId: string, parentSessionId: string | undefined): void {
		if (conn.browserSessions.delete(sessionId)) {
			this.#emit(conn, "Target.detachedFromTarget", { sessionId, targetId: BROWSER_TARGET_ID }, parentSessionId);
			return;
		}
		const ref = conn.sessions.get(sessionId);
		if (!ref) return;
		conn.sessions.delete(sessionId);
		const targetId = ref.kind === "tab" ? tabTargetIdFromKey(ref.tabKey) : pageTargetIdFromKey(ref.tabKey);
		this.#emit(conn, "Target.detachedFromTarget", { sessionId, targetId }, parentSessionId);
		// An explicit release of the last session must drop the attachment too,
		// or it outlives every downstream session: the infobar stays up, and
		// dismissing it bans the tab for the rest of the epoch.
		this.#detachIfUnheld(ref.tabKey);
	}

	/**
	 * Release the tab's chrome.debugger attachment once no downstream session
	 * holds it. Inert while the long-lived registry connection still holds one.
	 */
	#detachIfUnheld(tabKey: string): void {
		if (this.#sessionHolders(tabKey).length > 0) return;
		const tab = this.#tabs.get(tabKey);
		if (!tab?.attached) return;
		tab.attached = false;
		this.#resetRuntime(tab);
		tab.reattachedAfterDetach = false;
		const done = this.#rpc({ op: "detach", tabId: tab.tabId }, this.#instanceFor(tab))
			.then(() => {})
			.catch(() => {})
			.finally(() => {
				if (tab.detaching === done) tab.detaching = null;
			});
		tab.detaching = done;
	}

	#instanceForNewTab(conn: CdpConnection, nearTargetId: unknown, near?: TabState): ExtInstance | undefined {
		if (near) return this.#instanceFor(near);
		if (nearTargetId !== undefined) {
			const parsed = typeof nearTargetId === "string" ? parseTargetId(nearTargetId) : null;
			const code = parsed?.key.split(":")[0];
			for (const inst of this.#instances.values()) {
				if (inst.code === code) return inst;
			}
			throw new Error(`No relay browser for target ${String(nearTargetId)}`);
		}
		if (conn.affineInstanceId) return this.#instances.get(conn.affineInstanceId);
		return this.#lastHello();
	}

	#resetRuntime(tab: TabState): void {
		tab.runtimeContexts.clear();
		tab.rootRuntimeEnabled = false;
		tab.rootRuntimeEnabling = null;
		tab.runtimeGeneration++;
		for (const conn of this.#conns.values()) {
			for (const ref of conn.sessions.values()) {
				if (ref.tabKey !== tab.tabKey) continue;
				ref.runtimeContexts.clear();
				ref.runtimeEnabling = null;
				ref.runtimeEpoch++;
			}
		}
		for (const child of tab.realSessions) {
			const sessionId = `SC${tab.extCode}.${tab.tabId}.${child}`;
			this.#realSessionTabs.delete(sessionId);
			for (const conn of this.#conns.values()) {
				for (const pageSession of conn.sessionsForTab(tab.tabKey, "page")) {
					this.#emit(conn, "Target.detachedFromTarget", { sessionId }, pageSession);
				}
			}
		}
		tab.realSessions.clear();
	}

	/** Connections currently holding any session on a tab. */
	#sessionHolders(tabKey: string): CdpConnection[] {
		const out: CdpConnection[] = [];
		for (const conn of this.#conns.values()) {
			if (conn.sessionsForTab(tabKey).length > 0) out.push(conn);
		}
		return out;
	}

	#emitTabAttached(conn: CdpConnection, tab: TabState): void {
		if (!tab.attached || !this.#eligible(tab) || this.#conns.get(conn.id) !== conn) return;
		if (conn.sessionsForTab(tab.tabKey, "tab").length > 0) return;
		const sessionId = this.#mintSession(conn, "tab", tab);
		this.#emit(conn, "Target.attachedToTarget", {
			sessionId,
			targetInfo: this.#tabInfo(tab, true),
			waitingForDebugger: false,
		});
	}

	async #ensureAttached(tab: TabState): Promise<boolean> {
		// The extension emits the detach echo before resolving the RPC. Awaiting
		// prevents a replacement attach racing either operation.
		while (tab.detaching) await tab.detaching;
		if (tab.discarded || !this.#eligible(tab) || this.#tabs.get(tab.tabKey) !== tab) return false;
		if (tab.attached) return true;
		const inst = this.#instances.get(tab.instanceId);
		if (!inst?.socket) return false;
		if (tab.attaching) {
			const attached = await tab.attaching;
			if (attached || tab.discarded || !this.#eligible(tab) || this.#tabs.get(tab.tabKey) !== tab) return attached;
			return this.#ensureAttached(tab);
		}
		const attempt = this.#rpc({ op: "attach", tabId: tab.tabId }, inst)
			.then(() => {
				if (tab.discarded || !this.#eligible(tab) || this.#tabs.get(tab.tabKey) !== tab) return false;
				tab.attached = true;
				tab.reattachedAfterDetach = true;
				return true;
			})
			.catch(err => {
				this.#log("attach failed", {
					tabKey: tab.tabKey,
					url: tab.url,
					error: err instanceof Error ? err.message : String(err),
				});
				if (!(err instanceof ExtensionReplacedError) && this.#eligible(tab)) tab.banned = true;
				return false;
			})
			.finally(() => {
				if (tab.attaching === attempt) tab.attaching = null;
			});
		tab.attaching = attempt;
		return await attempt;
	}

	#eligible(tab: TabState): boolean {
		if (tab.banned || this.#tabs.get(tab.tabKey) !== tab) return false;
		// A browser whose extension socket is gone cannot be driven; hide its
		// tabs from discovery until the instance reconnects.
		const inst = this.#instances.get(tab.instanceId);
		if (!inst?.socket || inst.workspaceWindowId === null || inst.workspaceWindowId !== tab.windowId) return false;
		if (!tab.url) return true;
		return !INELIGIBLE_URL.test(tab.url);
	}

	#browserInfo(): TargetInfo {
		return {
			targetId: BROWSER_TARGET_ID,
			type: "browser",
			title: "",
			url: "",
			// The root CDP WebSocket already attaches the browser implicitly.
			attached: true,
			canAccessOpener: false,
		};
	}

	#tabInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: tabTargetIdFromKey(tab.tabKey),
			type: "tab",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	#pageInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: pageTargetIdFromKey(tab.tabKey),
			type: "page",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	// ---- plumbing ---------------------------------------------------------------

	#reply(conn: CdpConnection, msg: CdpCommand, result: Record<string, unknown>): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
	}

	#replyError(conn: CdpConnection, msg: CdpCommand, message: string, code = CDP_ERROR_SERVER): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code, message } }));
	}

	#emit(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId?: string): void {
		conn.socket.send(JSON.stringify({ sessionId, method, params }));
	}

	/** The extension instance a tab belongs to; throws if the browser vanished. */
	#instanceFor(tab: TabState): ExtInstance {
		const inst = this.#instances.get(tab.instanceId);
		if (!inst) throw new Error("relay extension is not connected");
		return inst;
	}

	#rpc(req: RelayRpcRequest, inst: ExtInstance, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
		if (!inst.socket) return Promise.reject(new Error("relay extension is not connected"));
		if (req.op !== "detach") {
			if (req.op !== "createTab") {
				if (inst.workspaceWindowId === null)
					return Promise.reject(new Error("Agent workspace window is unavailable"));
				const tab = this.#tabs.get(tabKeyOf(inst.code, req.tabId));
				if (!tab || !this.#eligible(tab))
					return Promise.reject(new Error("Tab is not available in the agent workspace"));
			}
		}
		const id = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pendingRpc.delete(`${inst.instanceId}:${id}`);
			reject(new Error(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		// Creation/removal may publish a lifecycle event before their RPC acknowledgement.
		const tabKey = req.op === "createTab" || req.op === "removeTab" ? undefined : tabKeyOf(inst.code, req.tabId);
		const lifecycleWindowId =
			req.op === "removeTab" || req.op === "createTab" ? (inst.workspaceWindowId ?? undefined) : undefined;
		this.#pendingRpc.set(`${inst.instanceId}:${id}`, { resolve, reject, timer, tabKey, lifecycleWindowId });
		inst.socket.send(JSON.stringify({ t: "rpc", id, ...req } satisfies RelayToExtMessage));
		return promise;
	}
}
