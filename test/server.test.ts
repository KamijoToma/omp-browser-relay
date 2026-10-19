import { afterEach, describe, expect, it } from "bun:test";
import { RELAY_CAPABILITIES, RELAY_PROTOCOL_VERSION } from "../src/protocol";
import { type RelayServer, type RelayUnavailableInfo, startRelayServer } from "../src/server";

const EXTENSION_HELLO = {
	t: "hello",
	protocolVersion: RELAY_PROTOCOL_VERSION,
	browserSession: "test-run",
	discardedTabsProtocol: 1,
	instanceId: "test",
	workspaceWindowId: 1,
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [],
	attachedTabIds: [],
} as const;

async function rawGet(port: number, requestBytes: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let response = "";
	await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(socket) {
				socket.write(requestBytes);
			},
			data(_socket, chunk) {
				response += chunk.toString("latin1");
			},
			error(_socket, error) {
				reject(error);
			},
			close() {
				resolve(response);
			},
		},
	});
	return promise;
}

function decodeChunkedBody(body: string): string {
	let decoded = "";
	let offset = 0;
	while (true) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd === -1) throw new Error("Invalid chunked response: missing chunk size");
		const lengthText = body.slice(offset, lineEnd).split(";", 1)[0]!;
		const length = Number.parseInt(lengthText, 16);
		if (!Number.isFinite(length) || length < 0) throw new Error("Invalid chunked response: invalid chunk size");
		offset = lineEnd + 2;
		if (length === 0) return decoded;
		if (body.length < offset + length + 2) throw new Error("Invalid chunked response: truncated chunk");
		decoded += body.slice(offset, offset + length);
		offset += length;
		if (body.slice(offset, offset + 2) !== "\r\n")
			throw new Error("Invalid chunked response: missing chunk terminator");
		offset += 2;
	}
}

function parseVersion(response: string): Record<string, unknown> {
	const boundary = response.indexOf("\r\n\r\n");
	if (boundary === -1) throw new Error("Invalid HTTP response: missing header boundary");
	const headers = response.slice(0, boundary);
	const body = response.slice(boundary + 4);
	expect(headers).toContain("200");
	const parsed: unknown = JSON.parse(
		/\r\ntransfer-encoding:\s*chunked\b/i.test(headers) ? decodeChunkedBody(body) : body,
	);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Relay discovery response is not an object");
	}
	return parsed as Record<string, unknown>;
}

async function connectExtension(port: number): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
	ws.addEventListener(
		"open",
		() => {
			ws.send(JSON.stringify(EXTENSION_HELLO));
			resolve(ws);
		},
		{ once: true },
	);
	ws.addEventListener("error", () => reject(new Error("Extension socket failed to connect")), { once: true });
	return promise;
}

async function waitForDiscovery(port: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		if (response.status === 200) return;
	}
	throw new Error("Relay discovery endpoint did not become ready");
}

describe("browser relay discovery endpoint", () => {
	let relay: RelayServer | undefined;
	let extension: WebSocket | undefined;

	afterEach(() => {
		extension?.close();
		relay?.stop();
		extension = undefined;
		relay = undefined;
	});

	async function startReadyRelay(): Promise<number> {
		relay = startRelayServer({ port: 0 });
		const port = relay.port;
		extension = await connectExtension(port);
		await waitForDiscovery(port);
		return port;
	}

	it("serves capabilities and its canonical reference before the extension connects", async () => {
		relay = startRelayServer({ port: 0, token: "secret" });
		const base = `http://127.0.0.1:${relay.port}`;
		const response = await fetch(`${base}/capabilities`);
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		const capabilities = await response.json();
		expect(capabilities.backend).toEqual({
			supported: true,
			transport: "cdp",
			ready: false,
			extensionSeen: false,
		});
		const docs = await fetch(new URL(capabilities.docs.path, base));
		expect(docs.status).toBe(200);
		expect(docs.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		expect(docs.headers.get("access-control-allow-origin")).toBeNull();
		expect((await fetch(`${base}/capabilities`, { method: "POST" })).status).toBe(405);
		expect((await fetch(`${base}/docs`, { method: "POST" })).status).toBe(405);
		expect((await fetch(`${base}/json/version`)).status).toBe(503);
	});

	it("reports live readiness separately from supported capabilities", async () => {
		const port = await startReadyRelay();
		const base = `http://127.0.0.1:${port}`;
		const capabilities = await (await fetch(`${base}/capabilities`)).json();
		expect(capabilities.backend).toEqual({
			supported: true,
			transport: "cdp",
			ready: true,
			extensionSeen: true,
		});
		extension!.close();
		const deadline = Date.now() + 1_000;
		let disconnected = await (await fetch(`${base}/capabilities`)).json();
		while (disconnected.backend.ready && Date.now() < deadline) {
			disconnected = await (await fetch(`${base}/capabilities`)).json();
		}
		expect(disconnected.backend).toEqual({
			supported: true,
			transport: "cdp",
			ready: false,
			extensionSeen: true,
		});
		expect(disconnected.ompRelay).toEqual(capabilities.ompRelay);
		expect((await fetch(`${base}/docs`)).status).toBe(200);
	});

	it("advertises the requested Host authority so a remote Puppeteer client dials the relay", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(
			port,
			"GET /json/version HTTP/1.1\r\nHost: 100.100.92.97:12803\r\nConnection: close\r\n\r\n",
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe("ws://100.100.92.97:12803/cdp");
		expect(parseVersion(response).ompRelay).toEqual(RELAY_CAPABILITIES);
	});

	it("uses the loopback discovery URL when an HTTP/1.0 request has no Host header", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, "GET /json/version HTTP/1.0\r\n\r\n");
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	it("uses the loopback discovery URL when Host is empty", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, "GET /json/version HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n");
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	it("uses the loopback discovery URL when Host would produce an unusable WebSocket authority", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(
			port,
			"GET /json/version HTTP/1.1\r\nHost: bad/host@evil\r\nConnection: close\r\n\r\n",
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	it("reports 503 with extensionSeen=false while no extension has ever handshaken", async () => {
		relay = startRelayServer({ port: 0 });
		const port = relay.port;
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		expect(response.status).toBe(503);
		const info = (await response.json()) as RelayUnavailableInfo;
		expect(info.extensionSeen).toBeFalse();
		expect(info.uptimeMs).toBeGreaterThanOrEqual(0);
		expect(info.ompRelay).toEqual(RELAY_CAPABILITIES);
	});

	it("keeps extensionSeen=true across an extension disconnect so clients wait for the service-worker revival", async () => {
		const port = await startReadyRelay();
		extension!.close();
		const deadline = Date.now() + 1_000;
		let response = await fetch(`http://127.0.0.1:${port}/json/version`);
		while (response.status !== 503 && Date.now() < deadline) {
			response = await fetch(`http://127.0.0.1:${port}/json/version`);
		}
		expect(response.status).toBe(503);
		expect(((await response.json()) as RelayUnavailableInfo).extensionSeen).toBeTrue();
	});

	it("returns the real ephemeral listening port", async () => {
		relay = startRelayServer({ port: 0 });
		expect(relay.port).toBeGreaterThan(0);
		expect((await fetch(`http://127.0.0.1:${relay.port}/json/list`)).status).toBe(200);
	});

	it("rejects webpage origins on CDP and extension routes and requires the configured extension token", async () => {
		relay = startRelayServer({ port: 0, token: "secret" });
		const base = `http://127.0.0.1:${relay.port}`;
		expect((await fetch(`${base}/cdp`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
		expect((await fetch(`${base}/ext?token=secret`, { headers: { Origin: "https://evil.example" } })).status).toBe(
			403,
		);
		expect((await fetch(`${base}/ext`)).status).toBe(401);
		expect((await fetch(`${base}/ext?token=wrong`)).status).toBe(401);
		expect(
			(
				await fetch(`${base}/ext?token=secret`, {
					headers: { Origin: "chrome-extension://abcdefghijklmnop" },
				})
			).status,
		).toBe(426);
	});

	it("does not accept an old extension as a ready relay", async () => {
		relay = startRelayServer({ port: 0 });
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		extension = new WebSocket(`ws://127.0.0.1:${relay.port}/ext`);
		extension.addEventListener(
			"open",
			() =>
				extension!.send(
					JSON.stringify({
						t: "hello",
						userAgent: "legacy",
						browserVersion: "Chrome/151",
						tabs: [],
						attachedTabIds: [],
					}),
				),
			{ once: true },
		);
		extension.addEventListener("close", () => resolve(), { once: true });
		extension.addEventListener("error", () => reject(new Error("Extension handshake failed")), { once: true });
		await promise;
		const response = await fetch(`http://127.0.0.1:${relay.port}/json/version`);
		expect(response.status).toBe(503);
		expect(((await response.json()) as RelayUnavailableInfo).extensionSeen).toBeFalse();
	});

	it("throws on an occupied port without disturbing the original listener", async () => {
		relay = startRelayServer({ port: 0 });
		expect(() => startRelayServer({ port: relay!.port })).toThrow();
		expect((await fetch(`http://127.0.0.1:${relay.port}/json/version`)).status).toBe(503);
	});
});
