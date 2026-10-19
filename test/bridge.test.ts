import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { RelayBridge, type RelaySocket } from "../src/bridge";
import type { RelayRpcRequest, RelayToExtMessage, TabSnapshot } from "../src/protocol";

/** Same derivation as the bridge: target ids embed this per-instance code. */
function instanceCode(instanceId: string, browserSession = "test-run"): string {
	return createHash("sha256").update(`${instanceId}:${browserSession}`).digest("base64url").slice(0, 8);
}

const ANON = instanceCode("anon");

/** A relay→extension RPC narrowed to one op, tabIds/title/etc. included. */
type ExtRpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	closed = false;
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {
		this.closed = true;
	}
	rpcs<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.messages.filter((msg): msg is ExtRpc<Op> => msg.t === "rpc" && msg.op === op);
	}
	/** RPC requests of `op` not yet answered through {@link ack}. */
	pending<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.rpcs(op).filter(msg => !this.#acked.has(msg.id));
	}
	markAcked(id: number): void {
		this.#acked.add(id);
	}
}

/** Downstream puppeteer-side socket capturing bridge emissions. */
class FakeCdpSocket implements RelaySocket {
	readonly messages: Array<Record<string, unknown>> = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text) as Record<string, unknown>);
	}
	close(): void {}
	sessionFor(commandId: number): string | undefined {
		const msg = this.messages.find(m => m.id === commandId);
		const result = msg && "result" in msg && msg.result && typeof msg.result === "object" ? msg.result : undefined;
		return result && "sessionId" in result && typeof result.sessionId === "string" ? result.sessionId : undefined;
	}
	/** Session ids the bridge announced through `Target.attachedToTarget`. */
	attachedSessions(): string[] {
		const out: string[] = [];
		for (const msg of this.messages) {
			if (msg.method !== "Target.attachedToTarget") continue;
			const params = msg.params;
			if (params && typeof params === "object" && "sessionId" in params && typeof params.sessionId === "string") {
				out.push(params.sessionId);
			}
		}
		return out;
	}
}

function tab(overrides: Partial<TabSnapshot> & { tabId: number }): TabSnapshot {
	return {
		url: "https://example.com/",
		title: "Example",
		active: false,
		discarded: false,
		windowId: 1,
		...overrides,
	};
}

function connect(
	bridge: RelayBridge,
	socket: FakeExtSocket,
	tabs: TabSnapshot[],
	attachedTabIds: number[] = [],
	browserSession = "test-run",
): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			protocolVersion: 3,
			browserSession,
			discardedTabsProtocol: 1,
			instanceId: "anon",
			workspaceWindowId: 1,
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			tabs,
			attachedTabIds,
		}),
	);
}

function connectInstance(
	bridge: RelayBridge,
	socket: FakeExtSocket,
	instanceId: string,
	tabs: TabSnapshot[],
	attachedTabIds: number[] = [],
): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			instanceId,
			protocolVersion: 3,
			browserSession: "test-run",
			discardedTabsProtocol: 1,
			workspaceWindowId: 1,
			userAgent: "test",
			browserVersion: instanceId === "edge" ? "Edg/151.0.0.0" : "Chrome/151.0.0.0",
			tabs,
			attachedTabIds,
		}),
	);
}

/** Answer every unanswered extension RPC of `op` with `ok: true` and `result`. */
function ack(bridge: RelayBridge, socket: FakeExtSocket, op: RelayRpcRequest["op"], result: unknown = {}): void {
	for (const rpc of socket.pending(op)) {
		socket.markAcked(rpc.id);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result }));
	}
}

/** Fail every unanswered extension RPC of `op` with `ok: false`. */
function nack(bridge: RelayBridge, socket: FakeExtSocket, op: RelayRpcRequest["op"], error = "rpc failed"): void {
	for (const rpc of socket.pending(op)) {
		socket.markAcked(rpc.id);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: false, error }));
	}
}

/** Flush the rpc .then() microtask chains (no timers involved). */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

let msgSeq = 100;

/** Attach to a tab's page target and return the minted page session id. */
async function attachPage(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connId: number,
	tabId: number,
	instanceId = "anon",
): Promise<string> {
	const attachId = ++msgSeq;
	bridge.cdpMessage(
		connId,
		JSON.stringify({
			id: attachId,
			method: "Target.attachToTarget",
			params: { targetId: `PAGE${instanceCode(instanceId)}.${tabId}`, flatten: true },
		}),
	);
	ack(bridge, ext, "attach");
	await flush();
	const sessionId = cdp.sessionFor(attachId);
	if (!sessionId) throw new Error(`attachToTarget for tab ${tabId} did not produce a session`);
	return sessionId;
}

/** Discover and attach the browser target, as browser.target().createCDPSession() does. */
function attachBrowser(bridge: RelayBridge, cdp: FakeCdpSocket, conn: number): string {
	bridge.cdpMessage(
		conn,
		JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets", params: { discover: true } }),
	);
	const created = cdp.messages.find(message => {
		const params = message.params as { targetInfo?: { type: string } } | undefined;
		return message.method === "Target.targetCreated" && params?.targetInfo?.type === "browser";
	});
	const params = created?.params as { targetInfo: { targetId: string } } | undefined;
	if (!params) throw new Error("Discovery did not announce the browser target");
	const id = ++msgSeq;
	bridge.cdpMessage(
		conn,
		JSON.stringify({
			id,
			method: "Target.attachToTarget",
			params: { targetId: params.targetInfo.targetId, flatten: true },
		}),
	);
	const sessionId = cdp.sessionFor(id);
	if (!sessionId) throw new Error("Browser target attachment did not produce a session");
	return sessionId;
}

describe("RelayBridge target discovery", () => {
	it("enumerates current eligible workspace pages without attaching", () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [
			tab({ tabId: 1 }),
			tab({ tabId: 2, url: "about:blank" }),
			tab({ tabId: 3, url: "chrome://extensions/" }),
		]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: "Target.getTargets" }));
		const first = cdp.messages.find(message => message.id === 1)?.result as
			| { targetInfos: Array<{ targetId: string; type: string }> }
			| undefined;
		expect(first?.targetInfos.map(info => [info.targetId, info.type]).sort()).toEqual([
			[`PAGE${ANON}.1`, "page"],
			[`PAGE${ANON}.2`, "page"],
		]);
		bridge.extMessage(ext, JSON.stringify({ t: "tabRemoved", tabId: 2 }));
		bridge.cdpMessage(connId, JSON.stringify({ id: 2, method: "Target.getTargets" }));
		const second = cdp.messages.find(message => message.id === 2)?.result as
			| { targetInfos: Array<{ targetId: string }> }
			| undefined;
		expect(second?.targetInfos.map(info => info.targetId)).toEqual([`PAGE${ANON}.1`]);
		expect(ext.messages.filter(message => message.t === "rpc")).toEqual([]);
	});
});
describe("RelayBridge browser target sessions", () => {
	it("routes browser metadata and owned close through an isolated browser session", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2, windowId: 9 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const sessionId = attachBrowser(bridge, cdp, conn);
		expect(ext.messages).toEqual([]);
		expect(cdp.messages.find(message => message.method === "Target.attachedToTarget")).toMatchObject({
			params: { sessionId, targetInfo: { targetId: "relay-browser", type: "browser", attached: true } },
		});
		const versionId = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: versionId, sessionId, method: "Browser.getVersion" }));
		expect(cdp.messages.find(message => message.id === versionId)).toMatchObject({
			sessionId,
			result: { product: "Chrome/151.0.0.0", userAgent: "test" },
		});
		const infoId = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: infoId,
				sessionId,
				method: "Target.getTargetInfo",
				params: { targetId: `PAGE${ANON}.1` },
			}),
		);
		expect(cdp.messages.find(message => message.id === infoId)).toMatchObject({
			sessionId,
			result: { targetInfo: { targetId: `PAGE${ANON}.1`, type: "page" } },
		});
		const closeId = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: closeId,
				sessionId,
				method: "Target.closeTarget",
				params: { targetId: `PAGE${ANON}.1` },
			}),
		);
		expect(ext.pending("removeTab").map(rpc => rpc.tabId)).toEqual([1]);
		bridge.extMessage(ext, JSON.stringify({ t: "tabRemoved", tabId: 1 }));
		ack(bridge, ext, "removeTab");
		await flush();
		expect(cdp.messages.find(message => message.id === closeId)).toEqual({
			id: closeId,
			sessionId,
			result: { success: true },
		});
		const targetsId = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: targetsId, sessionId, method: "Target.getTargets" }));
		expect(cdp.messages.find(message => message.id === targetsId)).toEqual({
			id: targetsId,
			sessionId,
			result: { targetInfos: [] },
		});
		expect(ext.rpcs("attach")).toEqual([]);
	});

	it("keeps browser sessions connection-local and releases them without tab RPCs", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = attachBrowser(bridge, first, firstConn);
		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = attachBrowser(bridge, second, secondConn);
		expect(firstSession).not.toBe(secondSession);
		const foreignId = ++msgSeq;
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: foreignId, sessionId: firstSession, method: "Browser.getVersion" }),
		);
		await flush();
		expect(second.messages.find(message => message.id === foreignId)?.error).toBeDefined();
		const detachId = ++msgSeq;
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: detachId,
				method: "Target.detachFromTarget",
				params: { sessionId: firstSession },
			}),
		);
		expect(first.messages.find(message => message.method === "Target.detachedFromTarget")).toEqual({
			method: "Target.detachedFromTarget",
			params: { sessionId: firstSession, targetId: "relay-browser" },
		});
		const staleId = ++msgSeq;
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({ id: staleId, sessionId: firstSession, method: "Browser.getVersion" }),
		);
		await flush();
		expect(first.messages.find(message => message.id === staleId)?.error).toBeDefined();
		const liveId = ++msgSeq;
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: liveId, sessionId: secondSession, method: "Target.getTargetInfo" }),
		);
		expect(second.messages.find(message => message.id === liveId)).toMatchObject({
			sessionId: secondSession,
			result: { targetInfo: { targetId: "relay-browser", attached: true } },
		});
		bridge.cdpClosed(secondConn);
		const replacement = new FakeCdpSocket();
		const replacementConn = bridge.cdpConnected(replacement);
		const closedId = ++msgSeq;
		bridge.cdpMessage(
			replacementConn,
			JSON.stringify({ id: closedId, sessionId: secondSession, method: "Browser.getVersion" }),
		);
		await flush();
		expect(replacement.messages.find(message => message.id === closedId)?.error).toBeDefined();
		expect(ext.messages).toEqual([]);
	});

	it("rejects unknown targets, session discovery and browser-global side effects", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2, windowId: 7 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const browserSession = attachBrowser(bridge, cdp, conn);
		for (const sessionId of [undefined, browserSession]) {
			for (const targetId of ["unknown", `PAGE${ANON}.999`, `PAGE${ANON}.2`, "", 42]) {
				const id = ++msgSeq;
				bridge.cdpMessage(
					conn,
					JSON.stringify({ id, sessionId, method: "Target.getTargetInfo", params: { targetId } }),
				);
				expect(cdp.messages.find(message => message.id === id)).toMatchObject({
					id,
					error: { message: `No target with id ${targetId}` },
				});
			}
			for (const method of [
				"Browser.setDownloadBehavior",
				"Browser.close",
				"Browser.setWindowBounds",
				"Target.createBrowserContext",
				"Target.disposeBrowserContext",
			]) {
				const id = ++msgSeq;
				bridge.cdpMessage(
					conn,
					JSON.stringify({ id, sessionId, method, params: { behavior: "allow", downloadPath: "/tmp" } }),
				);
				expect(cdp.messages.find(message => message.id === id)?.error).toBeDefined();
			}
		}
		const eventCount = cdp.messages.filter(message => message.method).length;
		for (const method of ["Target.setAutoAttach", "Target.setDiscoverTargets"]) {
			const id = ++msgSeq;
			bridge.cdpMessage(
				conn,
				JSON.stringify({
					id,
					sessionId: browserSession,
					method,
					params: { autoAttach: true, flatten: true, discover: true },
				}),
			);
			expect(cdp.messages.find(message => message.id === id)).toMatchObject({
				sessionId: browserSession,
				error: { code: -32601 },
			});
		}
		await flush();
		expect(cdp.messages.filter(message => message.method)).toHaveLength(eventCount);
		expect(ext.messages).toEqual([]);
	});

	it("retains owned targets after a refused close without attaching pages", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [
			tab({ tabId: 1 }),
			tab({ tabId: 2, windowId: 7 }),
			tab({ tabId: 3, url: "chrome://settings/" }),
		]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const sessionId = attachBrowser(bridge, cdp, conn);
		expect(cdp.messages.filter(message => message.method === "Target.targetCreated")).toHaveLength(3);
		for (const querySession of [undefined, sessionId]) {
			const id = ++msgSeq;
			bridge.cdpMessage(conn, JSON.stringify({ id, sessionId: querySession, method: "Target.getTargets" }));
			expect(cdp.messages.find(message => message.id === id)?.result).toEqual({
				targetInfos: [
					{
						targetId: `PAGE${ANON}.1`,
						type: "page",
						title: "Example",
						url: "https://example.com/",
						attached: false,
						canAccessOpener: false,
					},
				],
			});
		}
		expect(bridge.listTargets().map(target => target.id)).toEqual([`PAGE${ANON}.1`]);
		expect(ext.messages).toEqual([]);
		const closeId = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: closeId,
				sessionId,
				method: "Target.closeTarget",
				params: { targetId: `PAGE${ANON}.1` },
			}),
		);
		expect(ext.pending("removeTab").map(rpc => rpc.tabId)).toEqual([1]);
		nack(bridge, ext, "removeTab", "close refused");
		await flush();
		expect(cdp.messages.find(message => message.id === closeId)).toMatchObject({
			sessionId,
			error: { message: "close refused" },
		});
		expect(bridge.listTargets().map(target => target.id)).toEqual([`PAGE${ANON}.1`]);
	});

	it("preserves last-tab close acknowledgement while retiring its window and rejecting other work", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, conn, 1);
		const inputId = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: inputId,
				sessionId,
				method: "Input.dispatchMouseEvent",
				params: { type: "mouseMoved", x: 10, y: 20 },
			}),
		);
		const closeId = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({ id: closeId, method: "Target.closeTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		bridge.extMessage(ext, JSON.stringify({ t: "workspace", windowId: null }));
		bridge.extMessage(ext, JSON.stringify({ t: "tabRemoved", tabId: 1 }));
		ack(bridge, ext, "removeTab", {});
		await flush();
		expect(cdp.messages.find(message => message.id === closeId)?.result).toEqual({ success: true });
		expect(cdp.messages.find(message => message.id === inputId)?.error).toBeDefined();
		expect(bridge.listTargets()).toEqual([]);
	});

	it("preserves fresh-page provisioning across retirement of its previous workspace", async () => {
		const bridge = new RelayBridge(),
			ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket(),
			conn = bridge.cdpConnected(cdp),
			id = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({ id, method: "Target.createTarget", params: { url: "https://replacement.example" } }),
		);
		bridge.extMessage(ext, JSON.stringify({ t: "workspace", windowId: null }));
		bridge.extMessage(ext, JSON.stringify({ t: "workspace", windowId: 7 }));
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 2, windowId: 7, url: "https://replacement.example" }) });
		await flush();
		expect(cdp.messages.find(message => message.id === id)?.result).toEqual({ targetId: `PAGE${ANON}.2` });
		expect(bridge.listTargets().map(target => target.url)).toEqual(["https://replacement.example"]);
	});
});

describe("RelayBridge Runtime sessions", () => {
	it("virtualizes Runtime enable state for each pseudo-session", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, ext, first, firstConn, 1);
		bridge.cdpMessage(firstConn, JSON.stringify({ id: ++msgSeq, sessionId: firstSession, method: "Runtime.enable" }));
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext, "send");
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);

		const context = {
			context: {
				id: 17,
				origin: "https://example.com",
				name: "",
				uniqueId: "context-17",
				auxData: { isDefault: true, type: "default", frameId: "frame-1" },
			},
		};
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		ack(bridge, ext, "send");
		await flush();

		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, ext, second, secondConn, 1);
		const runtimeSendCount = ext.rpcs("send").length;
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Runtime.enable" }),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(runtimeSendCount);

		const contexts = second.messages.filter(
			message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
		);
		expect(contexts.map(message => message.params)).toEqual([context]);

		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Runtime.disable" }),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(runtimeSendCount);

		const nextContext = {
			context: { ...context.context, id: 18, uniqueId: "context-18" },
		};
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: nextContext }),
		);
		const firstContexts = first.messages.filter(
			message => message.sessionId === firstSession && message.method === "Runtime.executionContextCreated",
		);
		expect(firstContexts.map(message => message.params)).toEqual([context, nextContext]);
		expect(
			second.messages.filter(
				message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
			),
		).toEqual(contexts);
	});

	it("keeps a pipelined Runtime.disable authoritative while root enable completes", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.enable" }));
		await flush();

		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.disable" }));
		ack(bridge, ext, "send");
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);

		const context = { context: { id: 19 } };
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		ack(bridge, ext, "send");
		await flush();

		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual([]);
	});
	it("refreshes Runtime contexts after the extension reconnects", async () => {
		const bridge = new RelayBridge({});
		const firstExt = new FakeExtSocket();
		connect(bridge, firstExt, [tab({ tabId: 1 })]);

		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, firstExt, first, firstConn, 1);
		bridge.cdpMessage(firstConn, JSON.stringify({ id: ++msgSeq, sessionId: firstSession, method: "Runtime.enable" }));
		await flush();
		ack(bridge, firstExt, "send");
		await flush();
		const staleContext = { context: { id: 17 } };
		bridge.extMessage(
			firstExt,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: staleContext,
			}),
		);
		ack(bridge, firstExt, "send");
		await flush();

		bridge.extClosed(firstExt);
		const nextExt = new FakeExtSocket();
		bridge.extConnected(nextExt);
		bridge.extMessage(
			nextExt,
			JSON.stringify({
				t: "hello",
				protocolVersion: 3,
				browserSession: "test-run",
				discardedTabsProtocol: 1,
				instanceId: "anon",
				workspaceWindowId: 1,
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1 })],
				attachedTabIds: [1],
			}),
		);

		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, nextExt, second, secondConn, 1);
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Runtime.enable" }),
		);
		await flush();
		expect(nextExt.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, nextExt, "send");
		await flush();
		expect(nextExt.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);

		const currentContext = { context: { id: 18 } };
		bridge.extMessage(
			nextExt,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: currentContext,
			}),
		);
		ack(bridge, nextExt, "send");
		await flush();

		const contexts = second.messages.filter(
			message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
		);
		expect(contexts.map(message => message.params)).toEqual([currentContext]);
	});
});

describe("RelayBridge attachment release", () => {
	it("detaches cleanly on explicit last-session release and permits reattachment", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);

		// Mirror Chrome: onDetach reaches the bridge before detach's RPC result.
		// This echo is expected and must not ban/retract the live target.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		ack(bridge, ext, "detach");
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		ack(bridge, ext, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
		expect(cdp.messages.some(message => message.method === "Target.targetDestroyed")).toBe(false);
	});

	it("serializes immediate reattachment behind the detach RPC and its echo", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();
		// Only the initial attach has reached the extension while detach is pending.
		expect(ext.rpcs("attach")).toHaveLength(1);

		bridge.extMessage(
			ext,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		ack(bridge, ext, "detach");
		await flush();
		expect(ext.rpcs("attach")).toHaveLength(2);
		ack(bridge, ext, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
	});

	it("keeps the attachment while another connection still holds a session on the tab", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		// Long-lived registry connection: holds a session on the tab throughout.
		const registry = new FakeCdpSocket();
		const registryConn = bridge.cdpConnected(registry);
		await attachPage(bridge, ext, registry, registryConn, 1);
		const worker = new FakeCdpSocket();
		const workerConn = bridge.cdpConnected(worker);
		const sessionId = await attachPage(bridge, ext, worker, workerConn, 1);
		bridge.cdpMessage(
			workerConn,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.rpcs("detach")).toHaveLength(0);
	});

	it("detaches once the tab session released alongside the page session leaves no holder", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// setAutoAttach mints a tab session; attachToTarget adds a page session.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach" }));
		ack(bridge, ext, "attach");
		await flush();
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);
		const tabSession = cdp.attachedSessions().find(id => id !== pageSession);
		if (!tabSession) throw new Error("setAutoAttach did not mint a tab session");
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId: pageSession } }),
		);
		await flush();
		// The tab session still holds the attachment.
		expect(ext.rpcs("detach")).toHaveLength(0);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId: tabSession } }),
		);
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);
	});

	it("retracts held sessions when reconnect reattachment fails", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		expect(replacement.pending("attach")).toHaveLength(1);
		nack(bridge, replacement, "attach", "debugger unavailable");
		await flush();

		const detached = cdp.messages.find(
			message =>
				message.method === "Target.detachedFromTarget" &&
				message.params !== null &&
				typeof message.params === "object" &&
				"sessionId" in message.params &&
				message.params.sessionId === sessionId,
		);
		expect(detached).toBeDefined();
	});

	it("reconciles a delayed detach after replacement hello still reports the old attachment", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })], [1]);
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
	});

	it("does not ban a tab when its in-flight attach is interrupted by extension replacement", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		expect(ext.pending("attach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		await flush();

		const retryId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: retryId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(retryId)).toBeDefined();
	});

	it("clears an in-flight detach immediately when the extension socket is replaced", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.pending("detach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		await flush();

		// Reattachment reaches the replacement immediately; it does not wait
		// for the old socket's unreachable detach result or its 20s timeout.
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		const replacementSession = cdp.sessionFor(reattachId);
		expect(replacementSession).toBeDefined();

		// The old chrome.debugger.detach finishes after replacement attach and
		// sends its callback through the new global extension socket. Correlation
		// must survive the rejected RPC so this cannot retract the new session.
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		await flush();
		const replacementDetach = cdp.messages.find(
			message =>
				message.method === "Target.detachedFromTarget" &&
				message.params !== null &&
				typeof message.params === "object" &&
				"sessionId" in message.params &&
				message.params.sessionId === replacementSession,
		);
		expect(replacementDetach).toBeUndefined();

		// A later genuine user cancellation has no relay attribution and must
		// still retract the replacement session.
		bridge.extMessage(replacement, JSON.stringify({ t: "detached", tabId: 1, reason: "canceled_by_user" }));
		await flush();
		const userDetach = cdp.messages.find(
			message =>
				message.method === "Target.detachedFromTarget" &&
				message.params !== null &&
				typeof message.params === "object" &&
				"sessionId" in message.params &&
				message.params.sessionId === replacementSession,
		);
		expect(userDetach).toBeDefined();
	});

	it("still fans root Runtime events out to a session that never enabled the domain", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// omp's own patched-puppeteer client pull-acquires contexts and never
		// sends Runtime.enable, yet still waits on executionContextCreated.
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const context = { context: { id: 42, uniqueId: "context-42" } };
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);

		const received = cdp.messages.filter(
			message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
		);
		expect(received.map(message => message.params)).toEqual([context]);

		// An explicit disable silences the same session — a later re-emit is dropped.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.disable" }));
		await flush();
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual(received);
	});

	it("holds a pipelined duplicate Runtime.enable until the in-flight enable settles", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const enable1 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable1, sessionId, method: "Runtime.enable" }));
		await flush();
		const enable2 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable2, sessionId, method: "Runtime.enable" }));
		await flush();

		// Root disable/enable cycle still pending: neither caller may be acked.
		expect(cdp.messages.filter(message => message.id === enable1 || message.id === enable2)).toEqual([]);

		ack(bridge, ext, "send"); // Runtime.disable leg
		await flush();
		ack(bridge, ext, "send"); // Runtime.enable leg
		await flush();

		expect(cdp.messages.filter(message => message.id === enable1 && "result" in message)).toHaveLength(1);
		expect(cdp.messages.filter(message => message.id === enable2 && "result" in message)).toHaveLength(1);
	});

	it("fails a pipelined duplicate Runtime.enable when the root enable fails", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const enable1 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable1, sessionId, method: "Runtime.enable" }));
		await flush();
		const enable2 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable2, sessionId, method: "Runtime.enable" }));
		await flush();

		// The first leg of the root cycle fails: both callers must observe it.
		nack(bridge, ext, "send");
		await flush();

		expect(cdp.messages.filter(message => message.id === enable1 && "error" in message)).toHaveLength(1);
		expect(cdp.messages.filter(message => message.id === enable2 && "error" in message)).toHaveLength(1);
		expect(
			cdp.messages.filter(message => (message.id === enable1 || message.id === enable2) && "result" in message),
		).toEqual([]);
	});

	it("preserves the latest disable when an older and newer enable both fail", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.enable" }));
		await flush();
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.disable" }));
		const latestEnable = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: latestEnable, sessionId, method: "Runtime.enable" }));
		await flush();

		nack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === latestEnable && "error" in message)).toHaveLength(1);

		const context = { context: { id: 91, uniqueId: "context-91" } };
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual([]);
	});
});

describe("RelayBridge multiple extension instances", () => {
	it("keeps each browser's tabs listed when two instances connect", () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		expect(
			bridge
				.listTargets()
				.map(t => [t.title, t.id])
				.sort(),
		).toEqual([
			["Chrome tab", `PAGE${instanceCode("chrome")}.1`],
			["Edge tab", `PAGE${instanceCode("edge")}.1`],
		]);
	});

	it("scopes the hello GC to the reconnecting instance", () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		const edge = new FakeExtSocket();
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		// Edge reconnects without its tab: its own tab goes, Chrome's tab stays.
		bridge.extClosed(edge);
		const edge2 = new FakeExtSocket();
		connectInstance(bridge, edge2, "edge", []);
		expect(bridge.listTargets().map(t => t.title)).toEqual(["Chrome tab"]);
	});

	it("replaces the socket, resets runtime state, and keeps the registry when the same instance reconnects", async () => {
		const bridge = new RelayBridge({});
		const first = new FakeExtSocket();
		connectInstance(bridge, first, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const session = await attachPage(bridge, first, cdp, connId, 1, "chrome");
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: session, method: "Runtime.enable" }));
		await flush();
		ack(bridge, first, "send");
		await flush();
		ack(bridge, first, "send");
		await flush();
		expect(first.rpcs("send").map(rpc => rpc.method)).toEqual(["Runtime.disable", "Runtime.enable"]);
		// Service-worker restart: a new socket helloes for the same instance.
		const second = new FakeExtSocket();
		connectInstance(bridge, second, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		expect(first.closed).toBe(true);
		// One listing per physical tab, not one per connection.
		expect(bridge.listTargets()).toHaveLength(1);
		// The runtime reset must reach the replacement socket: a fresh
		// Runtime.enable has to re-run the disable/enable cycle instead of
		// short-circuiting on stale rootRuntimeEnabled state.
		const newSession = await attachPage(bridge, second, cdp, connId, 1, "chrome");
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId: newSession, method: "Runtime.enable" }));
		await flush();
		expect(second.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, second, "send");
		await flush();
		expect(second.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);
	});

	it("routes rpcs to the browser instance that owns the tab", async () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		const chromeCdp = new FakeCdpSocket();
		const chromeConn = bridge.cdpConnected(chromeCdp);
		const edgeCdp = new FakeCdpSocket();
		const edgeConn = bridge.cdpConnected(edgeCdp);
		// Same chrome tabId (1) in both browsers: routing must disambiguate by instance.
		const chromeSession = await attachPage(bridge, chrome, chromeCdp, chromeConn, 1, "chrome");
		const edgeSession = await attachPage(bridge, edge, edgeCdp, edgeConn, 1, "edge");
		bridge.cdpMessage(
			chromeConn,
			JSON.stringify({ id: ++msgSeq, sessionId: chromeSession, method: "Runtime.enable" }),
		);
		bridge.cdpMessage(edgeConn, JSON.stringify({ id: ++msgSeq, sessionId: edgeSession, method: "Runtime.enable" }));
		await flush();
		const chromeSends = chrome.rpcs("send").map(rpc => rpc.tabId);
		const edgeSends = edge.rpcs("send").map(rpc => rpc.tabId);
		expect(chromeSends).toEqual([1]);
		expect(edgeSends).toEqual([1]);
	});
});

describe("RelayBridge last-hello fallback and offline instance pruning", () => {
	it("falls back to a live instance for browser-wide requests when the last hello goes offline", async () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		bridge.extClosed(edge);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({
				id: ++msgSeq,
				method: "Target.createTarget",
				params: { url: "https://example.com/" },
			}),
		);
		expect(chrome.rpcs("createTab")).toHaveLength(1);
		expect(edge.rpcs("createTab")).toHaveLength(0);
		ack(bridge, chrome, "createTab", {
			tab: tab({ tabId: 9, title: "Created", url: "https://example.com/9" }),
		});
		await flush();
		expect(bridge.versionInfo("ws://relay").Browser).toBe("Chrome/151.0.0.0");
		expect(bridge.listTargets().map(t => t.title)).toContain("Created");
	});

	it("hides tabs of an instance whose socket went offline", () => {
		const bridge = new RelayBridge({});
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [
			tab({ tabId: 1, title: "Chrome tab", url: "https://chrome.example/" }),
		]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		bridge.extClosed(edge);
		expect(bridge.listTargets().map(t => t.title)).toEqual(["Chrome tab"]);
		// The registry survives for the reconnect; the hello re-adds the tab.
		const edge2 = new FakeExtSocket();
		connectInstance(bridge, edge2, "edge", [tab({ tabId: 1, title: "Edge tab", url: "https://edge.example/" })]);
		expect(bridge.listTargets().map(t => t.title)).toEqual(["Chrome tab", "Edge tab"]);
	});
});

describe("RelayBridge dedicated workspace boundary", () => {
	it("rejects legacy and malformed hellos without making discovery ready", () => {
		for (const overrides of [
			{ protocolVersion: undefined },
			{ protocolVersion: 1 },
			{ protocolVersion: 2 },
			{ instanceId: "" },
			{ instanceId: undefined },
			{ instanceId: "bad:instance" },
			{ workspaceWindowId: "1" },
			{ attachedTabIds: ["1"] },
			{ tabs: [null] },
		]) {
			const bridge = new RelayBridge();
			const ext = new FakeExtSocket();
			bridge.extConnected(ext);
			bridge.extMessage(
				ext,
				JSON.stringify({
					t: "hello",
					protocolVersion: 3,
					browserSession: "test-run",
					discardedTabsProtocol: 1,
					instanceId: "valid",
					userAgent: "test",
					browserVersion: "Chrome/151",
					workspaceWindowId: 1,
					tabs: [],
					attachedTabIds: [],
					...overrides,
				}),
			);
			expect(ext.closed).toBeTrue();
			expect(bridge.ready).toBeFalse();
			expect(bridge.extensionSeen).toBeFalse();
		}
	});

	it("never discovers or routes commands to tabs outside the owning workspace", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2, windowId: 7 })]);
		bridge.extMessage(ext, JSON.stringify({ t: "tabCreated", tab: tab({ tabId: 3, windowId: 7 }) }));
		expect(bridge.listTargets().map(target => target.id)).toEqual([`PAGE${ANON}.1`]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		for (const method of ["Target.activateTarget", "Target.attachToTarget", "Target.closeTarget"]) {
			const id = ++msgSeq;
			bridge.cdpMessage(conn, JSON.stringify({ id, method, params: { targetId: `PAGE${ANON}.2` } }));
			await flush();
			expect(cdp.messages.find(message => message.id === id)?.error).toBeDefined();
		}
		expect(ext.messages).toEqual([]);
	});

	it("revokes page and real child sessions on move-out without reviving them on adoption", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, conn, 1);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Target.attachedToTarget",
				params: { sessionId: "child", targetInfo: { targetId: "frame", type: "iframe" } },
			}),
		);
		const evaluation = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: evaluation, sessionId, method: "Runtime.evaluate" }));
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, windowId: 7 }) }));
		expect(bridge.listTargets()).toEqual([]);
		await flush();
		expect(cdp.messages.find(message => message.id === evaluation)?.error).toBeDefined();
		ack(bridge, ext, "send");
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1 }) }));
		expect(bridge.listTargets().map(target => target.id)).toEqual([`PAGE${ANON}.1`]);
		for (const session of [sessionId, `SC${ANON}.1.child`]) {
			const id = ++msgSeq;
			bridge.cdpMessage(conn, JSON.stringify({ id, sessionId: session, method: "Page.bringToFront" }));
			await flush();
			expect(cdp.messages.find(message => message.id === id)?.error).toBeDefined();
		}
		expect(ext.rpcs("activateTab")).toEqual([]);
		expect(cdp.messages.some(message => message.method === "Target.detachedFromTarget")).toBeTrue();
		const adopted = await attachPage(bridge, ext, cdp, conn, 1);
		expect(adopted).not.toBe(sessionId);
		const evaluateAdopted = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: evaluateAdopted, sessionId: adopted, method: "Runtime.evaluate" }));
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.find(message => message.id === evaluateAdopted)?.result).toEqual({});
	});

	it("bootstraps an absent workspace and recreates it after close without retaining old sessions", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		bridge.extConnected(ext);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "hello",
				protocolVersion: 3,
				browserSession: "test-run",
				discardedTabsProtocol: 1,
				instanceId: "anon",
				userAgent: "test",
				browserVersion: "Chrome/151",
				workspaceWindowId: null,
				tabs: [],
				attachedTabIds: [],
			}),
		);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const first = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: first, method: "Target.createTarget" }));
		bridge.extMessage(ext, JSON.stringify({ t: "workspace", windowId: 1 }));
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 1 }) });
		await flush();
		expect(cdp.messages.find(message => message.id === first)?.result).toEqual({ targetId: `PAGE${ANON}.1` });
		const session = await attachPage(bridge, ext, cdp, conn, 1);

		bridge.extMessage(ext, JSON.stringify({ t: "workspace", windowId: null }));
		expect(bridge.listTargets()).toEqual([]);
		const stale = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: stale, sessionId: session, method: "Runtime.evaluate" }));
		await flush();
		expect(cdp.messages.find(message => message.id === stale)?.error).toBeDefined();

		const replacement = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: replacement, method: "Target.createTarget" }));
		bridge.extMessage(ext, JSON.stringify({ t: "workspace", windowId: 2 }));
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 4, windowId: 2 }) });
		await flush();
		expect(cdp.messages.find(message => message.id === replacement)?.result).toEqual({ targetId: `PAGE${ANON}.4` });
		expect(bridge.listTargets().map(target => target.id)).toEqual([`PAGE${ANON}.4`]);
	});

	it("keeps active workspace pages controllable through membership and user tab updates", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		bridge.cdpMessage(conn, JSON.stringify({ id: ++msgSeq, method: "Target.setDiscoverTargets" }));
		const sessionId = await attachPage(bridge, ext, cdp, conn, 1);
		const evaluation = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: evaluation, sessionId, method: "Runtime.evaluate" }));
		bridge.extMessage(ext, JSON.stringify({ t: "workspace", windowId: 1 }));
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, title: "User editing", active: true }) }),
		);
		ack(bridge, ext, "send", { result: { type: "number", value: 42 } });
		await flush();
		expect(cdp.messages.find(message => message.id === evaluation)?.result).toEqual({
			result: { type: "number", value: 42 },
		});
		expect(bridge.listTargets()[0]).toMatchObject({ title: "User editing", active: "true" });
		for (const [method, params] of [
			["Page.handleJavaScriptDialog", { accept: true }],
			["Page.handleJavaScriptDialog", { accept: false }],
			["Page.screencastFrameAck", { sessionId: 7 }],
			["Page.stopScreencast", {}],
			["Fetch.continueRequest", { requestId: "blocked-request" }],
		] as const) {
			const id = ++msgSeq;
			bridge.cdpMessage(conn, JSON.stringify({ id, sessionId, method, params }));
			expect(ext.pending("send")[0]).toMatchObject({ tabId: 1, method, params });
			ack(bridge, ext, "send");
			await flush();
			expect(cdp.messages.find(message => message.id === id)?.result).toEqual({});
		}
		expect(cdp.messages.filter(message => message.method === "Target.detachedFromTarget")).toEqual([]);
	});

	it("cancels an in-flight attach when workspace ownership changes and adopts new members", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const interrupted = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: interrupted,
				method: "Target.attachToTarget",
				params: { targetId: `PAGE${ANON}.1` },
			}),
		);
		const stale = ext.pending("attach")[0]!;
		bridge.extMessage(ext, JSON.stringify({ t: "workspace", windowId: 2 }));
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 2, windowId: 2 }) }));
		ext.markAcked(stale.id);
		bridge.extMessage(ext, JSON.stringify({ t: "rpcResult", id: stale.id, ok: true, result: {} }));
		await flush();
		expect(cdp.messages.find(message => message.id === interrupted)?.error).toBeDefined();
		expect(bridge.listTargets().map(target => target.id)).toEqual([`PAGE${ANON}.2`]);
		const sessionId = await attachPage(bridge, ext, cdp, conn, 2);
		expect(sessionId).toBeDefined();
	});

	it("selects owned workspace tabs instead of forwarding any bringToFront command", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, conn, 1);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Target.attachedToTarget",
				params: { sessionId: "child", targetInfo: { targetId: "frame", type: "iframe" } },
			}),
		);
		for (const session of [sessionId, `SC${ANON}.1.child`]) {
			const id = ++msgSeq;
			bridge.cdpMessage(conn, JSON.stringify({ id, sessionId: session, method: "Page.bringToFront" }));
			ack(bridge, ext, "activateTab");
			await flush();
			expect(cdp.messages.find(message => message.id === id)?.result).toEqual({});
		}
		const id = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({ id, method: "Target.activateTarget", params: { targetId: `PAGE${ANON}.1` } }),
		);
		ack(bridge, ext, "activateTab");
		await flush();
		expect(ext.rpcs("activateTab").map(rpc => rpc.tabId)).toEqual([1, 1, 1]);
		expect(ext.rpcs("send")).toEqual([]);
	});

	it("blocks global page and child bypasses but preserves scoped OOPIF input", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, conn, 1);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Target.attachedToTarget",
				params: { sessionId: "child", targetInfo: { targetId: "frame", type: "iframe" } },
			}),
		);
		for (const session of [sessionId, `SC${ANON}.1.child`]) {
			for (const method of [
				"Browser.close",
				"Browser.getWindowForTarget",
				"Target.sendMessageToTarget",
				"Target.attachToTarget",
				"Target.getTargets",
			]) {
				const id = ++msgSeq;
				bridge.cdpMessage(conn, JSON.stringify({ id, sessionId: session, method }));
				await flush();
				expect(cdp.messages.find(message => message.id === id)?.error).toBeDefined();
			}
		}
		expect(ext.rpcs("send")).toEqual([]);
		const id = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id,
				sessionId: `SC${ANON}.1.child`,
				method: "Input.dispatchMouseEvent",
				params: { type: "mousePressed" },
			}),
		);
		expect(ext.pending("send")[0]?.sessionId).toBe("child");
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.find(message => message.id === id)?.result).toEqual({});
	});

	it("rejects extension creation results outside the selected instance workspace", async () => {
		const bridge = new RelayBridge();
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", []);
		connectInstance(bridge, edge, "edge", []);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const id = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id, method: "Target.createTarget" }));
		expect(chrome.rpcs("createTab")).toEqual([]);
		ack(bridge, edge, "createTab", { tab: tab({ tabId: 3, windowId: 9 }) });
		await flush();
		expect(cdp.messages.find(message => message.id === id)?.error).toBeDefined();
		expect(bridge.listTargets()).toEqual([]);
	});

	it("isolates identical Chrome child session ids from different browser instances", async () => {
		const bridge = new RelayBridge();
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 1 })]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		await attachPage(bridge, chrome, cdp, conn, 1, "chrome");
		await attachPage(bridge, edge, cdp, conn, 1, "edge");
		for (const ext of [chrome, edge]) {
			bridge.extMessage(
				ext,
				JSON.stringify({
					t: "cdpEvent",
					tabId: 1,
					method: "Target.attachedToTarget",
					params: { sessionId: "same-native-id", targetInfo: { targetId: "frame", type: "iframe" } },
				}),
			);
		}
		const id = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id,
				sessionId: `SC${instanceCode("chrome")}.1.same-native-id`,
				method: "Runtime.evaluate",
				params: { expression: "1" },
			}),
		);
		expect(chrome.pending("send")[0]?.sessionId).toBe("same-native-id");
		expect(edge.rpcs("send")).toEqual([]);
		ack(bridge, chrome, "send", { value: 1 });
		await flush();
		expect(cdp.messages.find(message => message.id === id)?.result).toEqual({ value: 1 });
	});

	it("translates owned OOPIF detach and revokes stale child sessions on reconnect", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const page = await attachPage(bridge, ext, cdp, conn, 1);
		const autoAttach = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: autoAttach,
				sessionId: page,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
			}),
		);
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.find(message => message.id === autoAttach)?.result).toEqual({});
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Target.attachedToTarget",
				params: { sessionId: "child", targetInfo: { targetId: "frame", type: "iframe" } },
			}),
		);
		const id = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id,
				sessionId: page,
				method: "Target.detachFromTarget",
				params: { sessionId: `SC${ANON}.1.child` },
			}),
		);
		expect(ext.pending("send")[0]?.params).toEqual({ sessionId: "child" });
		ack(bridge, ext, "send");
		await flush();
		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })], [1]);
		const staleCommand = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: staleCommand,
				sessionId: `SC${ANON}.1.child`,
				method: "Runtime.evaluate",
			}),
		);
		await flush();
		expect(cdp.messages.find(message => message.id === staleCommand)?.error).toBeDefined();
		expect(replacement.rpcs("send")).toEqual([]);
	});
});

describe("stock omp relay compatibility", () => {
	it("lists discarded tabs without announcing or auto-attaching them, then exposes a revived target", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1, discarded: true }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const discover = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: discover, method: "Target.setDiscoverTargets" }));
		const autoAttach = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: autoAttach, method: "Target.setAutoAttach" }));
		expect(bridge.listTargets().find(target => target.id === `PAGE${ANON}.1`)?.discarded).toBe("true");
		expect(ext.pending("attach").map(request => request.tabId)).toEqual([2]);
		ack(bridge, ext, "attach");
		await flush();
		expect(cdp.messages.find(message => message.id === autoAttach)?.result).toEqual({});
		expect(
			cdp.messages.some(message => {
				const params = message.params as { targetInfo?: { targetId: string } } | undefined;
				return message.method === "Target.targetCreated" && params?.targetInfo?.targetId === `PAGE${ANON}.1`;
			}),
		).toBeFalse();
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1 }) }));
		expect(ext.pending("attach").map(request => request.tabId)).toEqual([1]);
		ack(bridge, ext, "attach");
		await flush();
		expect(bridge.listTargets().find(target => target.id === `PAGE${ANON}.1`)?.discarded).toBe("false");
		expect(
			cdp.messages.some(message => {
				const params = message.params as { targetInfo?: { targetId: string } } | undefined;
				return message.method === "Target.attachedToTarget" && params?.targetInfo?.targetId === `TAB${ANON}.1`;
			}),
		).toBeTrue();
	});

	it("does not let a target id from a prior browser run address a reused Chrome tab id", async () => {
		const bridge = new RelayBridge();
		const first = new FakeExtSocket();
		connect(bridge, first, [tab({ tabId: 1 })]);
		const oldTarget = bridge.listTargets()[0]!.id;
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const page = await attachPage(bridge, first, cdp, conn, 1);
		bridge.extClosed(first);
		const next = new FakeExtSocket();
		connect(bridge, next, [tab({ tabId: 1 })], [], "new-browser-run");
		expect(bridge.listTargets()[0]!.id).not.toBe(oldTarget);
		const stale = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: stale, sessionId: page, method: "Runtime.evaluate" }));
		await flush();
		expect(cdp.messages.find(message => message.id === stale)?.error).toBeDefined();
		expect(next.rpcs("send")).toEqual([]);
	});

	it("never enables native focus when clients request focus emulation and releases only unheld tabs", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const first = new FakeCdpSocket();
		const second = new FakeCdpSocket();
		const connA = bridge.cdpConnected(first);
		const connB = bridge.cdpConnected(second);
		const pageA = await attachPage(bridge, ext, first, connA, 1);
		const pageB = await attachPage(bridge, ext, second, connB, 1);
		for (const [conn, cdp, page, enabled] of [
			[connA, first, pageA, true],
			[connB, second, pageB, true],
			[connA, first, pageA, false],
		] as const) {
			const id = ++msgSeq;
			bridge.cdpMessage(
				conn,
				JSON.stringify({ id, sessionId: page, method: "Emulation.setFocusEmulationEnabled", params: { enabled } }),
			);
			expect(ext.pending("send")[0]).toMatchObject({
				tabId: 1,
				method: "Emulation.setFocusEmulationEnabled",
				params: { enabled: false },
			});
			ack(bridge, ext, "send");
			await flush();
			expect(cdp.messages.find(message => message.id === id)?.result).toEqual({});
		}
		bridge.cdpClosed(connB);
		expect(ext.rpcs("detach")).toEqual([]);
		expect(ext.pending("send")).toEqual([]);
		const evaluate = ++msgSeq;
		bridge.cdpMessage(connA, JSON.stringify({ id: evaluate, sessionId: pageA, method: "Runtime.evaluate" }));
		ack(bridge, ext, "send");
		await flush();
		expect(first.messages.find(message => message.id === evaluate)?.result).toEqual({});
		bridge.cdpClosed(connA);
		expect(ext.pending("detach").map(request => request.tabId)).toEqual([1]);
		ack(bridge, ext, "detach");
		await flush();
	});

	it("rejects malformed focus requests and child-session focus changes", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const page = await attachPage(bridge, ext, cdp, conn, 1);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Target.attachedToTarget",
				params: { sessionId: "child", targetInfo: { targetId: "frame", type: "iframe" } },
			}),
		);
		for (const params of [undefined, {}, { enabled: "true" }, { enabled: 1 }, { enabled: null }]) {
			const id = ++msgSeq;
			bridge.cdpMessage(
				conn,
				JSON.stringify({ id, sessionId: page, method: "Emulation.setFocusEmulationEnabled", params }),
			);
			await flush();
			expect(cdp.messages.find(message => message.id === id)?.error).toBeDefined();
		}
		const child = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: child,
				sessionId: `SC${ANON}.1.child`,
				method: "Emulation.setFocusEmulationEnabled",
				params: { enabled: true },
			}),
		);
		await flush();
		expect(cdp.messages.find(message => message.id === child)?.error).toBeDefined();
		expect(ext.rpcs("send")).toEqual([]);
	});

	it("uses claimTarget as browser affinity without changing native focus", async () => {
		const bridge = new RelayBridge();
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 1 })]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const page = await attachPage(bridge, chrome, cdp, conn, 1, "chrome");
		const claim = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: claim, sessionId: page, method: "OMP.claimTarget" }));
		expect(cdp.messages.find(message => message.id === claim)?.result).toEqual({});
		expect(chrome.rpcs("send")).toEqual([]);
		expect(edge.rpcs("send")).toEqual([]);
		const create = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({ id: create, method: "Target.createTarget", params: { url: "https://example.com/new" } }),
		);
		expect(chrome.pending("createTab")).toHaveLength(1);
		expect(edge.rpcs("createTab")).toEqual([]);
		ack(bridge, chrome, "createTab", { tab: tab({ tabId: 2, url: "https://example.com/new" }) });
		await flush();
		expect(cdp.messages.find(message => message.id === create)?.result).toEqual({
			targetId: `PAGE${instanceCode("chrome")}.2`,
		});
	});

	it("routes a page-scoped create to its own browser rather than the last extension to connect", async () => {
		const bridge = new RelayBridge();
		const chrome = new FakeExtSocket();
		const edge = new FakeExtSocket();
		connectInstance(bridge, chrome, "chrome", [tab({ tabId: 1 })]);
		connectInstance(bridge, edge, "edge", [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		const page = await attachPage(bridge, chrome, cdp, conn, 1, "chrome");
		const create = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: create,
				sessionId: page,
				method: "Target.createTarget",
				params: { url: "about:blank", background: true },
			}),
		);
		expect(chrome.pending("createTab")).toHaveLength(1);
		expect(edge.rpcs("createTab")).toEqual([]);
		ack(bridge, chrome, "createTab", { tab: tab({ tabId: 2 }) });
		await flush();
		const result = cdp.messages.find(message => message.id === create)?.result as { targetId: string };
		expect(result.targetId).toBe(`PAGE${instanceCode("chrome")}.2`);
		const close = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: close,
				sessionId: page,
				method: "Target.closeTarget",
				params: { targetId: result.targetId },
			}),
		);
		bridge.extMessage(chrome, JSON.stringify({ t: "tabRemoved", tabId: 2 }));
		ack(bridge, chrome, "removeTab");
		await flush();
		expect(cdp.messages.find(message => message.id === close)?.result).toEqual({ success: true });
	});
});

describe("relay initialization interruptions", () => {
	it("completes the synthetic tab hierarchy across unchanged workspace notifications", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		bridge.cdpMessage(conn, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach" }));
		ack(bridge, ext, "attach");
		await flush();
		const tabSession = cdp.attachedSessions()[0]!;
		bridge.extMessage(ext, JSON.stringify({ t: "workspace", windowId: 1 }));
		const handshake = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: handshake,
				sessionId: tabSession,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, flatten: true },
			}),
		);
		expect(cdp.messages.find(message => message.id === handshake)?.result).toEqual({});
		const pageSession = cdp.attachedSessions()[1]!;
		expect(pageSession).toBeDefined();
		const evaluate = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: evaluate, sessionId: pageSession, method: "Runtime.evaluate" }));
		expect(ext.pending("send")[0]).toMatchObject({ tabId: 1, method: "Runtime.evaluate" });
		ack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.find(message => message.id === evaluate)?.result).toEqual({});
	});

	it("retries auto-attach when a discarded tab revives before its cancelled attach settles", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = bridge.cdpConnected(cdp);
		bridge.cdpMessage(conn, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach" }));
		const stale = ext.pending("attach")[0]!;
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, discarded: true }) }));
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1 }) }));
		ext.markAcked(stale.id);
		bridge.extMessage(ext, JSON.stringify({ t: "rpcResult", id: stale.id, ok: true, result: {} }));
		await flush();
		await flush();
		expect(ext.pending("attach").map(request => request.tabId)).toEqual([1]);
		ack(bridge, ext, "attach");
		await flush();
		expect(cdp.attachedSessions()).toHaveLength(1);
	});
});
