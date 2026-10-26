import { afterEach, describe, expect, it } from "bun:test";
import { networkInterfaces } from "node:os";
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

async function rawGet(port: number, requestBytes: string, hostname = "127.0.0.1"): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let response = "";
	await Bun.connect({
		hostname,
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

type TailnetAccessResult = {
	t: "tailnetAccessResult";
	requestId: number;
	ok: boolean;
	enabled: boolean;
	port: number;
	tailnetAddresses: string[];
	error?: string;
};

async function requestTailnetAccess(
	ws: WebSocket,
	request: { requestId: number; enabled?: boolean },
): Promise<TailnetAccessResult> {
	const { promise, resolve, reject } = Promise.withResolvers<TailnetAccessResult>();
	const cleanup = () => {
		ws.removeEventListener("message", onMessage);
		ws.removeEventListener("close", onClose);
		ws.removeEventListener("error", onError);
	};
	const fail = (error: Error) => {
		cleanup();
		reject(error);
	};
	const onMessage = (event: MessageEvent) => {
		if (typeof event.data !== "string") return;
		let response: unknown;
		try {
			response = JSON.parse(event.data);
		} catch {
			return;
		}
		if (response === null || typeof response !== "object" || Array.isArray(response)) return;
		const message = response as Partial<TailnetAccessResult>;
		if (message.t !== "tailnetAccessResult" || message.requestId !== request.requestId) return;
		cleanup();
		resolve(message as TailnetAccessResult);
	};
	const onClose = () => fail(new Error("Extension socket closed before the tailnet access response"));
	const onError = () => fail(new Error("Extension socket failed before the tailnet access response"));
	ws.addEventListener("message", onMessage);
	ws.addEventListener("close", onClose, { once: true });
	ws.addEventListener("error", onError, { once: true });
	ws.send(JSON.stringify({ t: "tailnetAccessRequest", ...request }));
	return promise;
}

async function findNonTailnetResponse(port: number): Promise<{ address: string; status: number } | undefined> {
	const candidates = Object.values(networkInterfaces())
		.flatMap(addresses => addresses ?? [])
		.filter(
			({ address, family, internal }) =>
				family === "IPv4" && !internal && !address.startsWith("100.") && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address),
		);
	for (const { address } of candidates) {
		try {
			const response = await fetch(`http://${address}:${port}/json/version`, {
				signal: AbortSignal.timeout(250),
			});
			return { address, status: response.status };
		} catch {
			continue;
		}
	}
	return undefined;
}

function extensionUpgradeIsRejected(hostname: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const ws = new WebSocket(`ws://${hostname}:${port}/ext`);
	let settled = false;
	const finish = (rejected: boolean) => {
		if (settled) return;
		settled = true;
		ws.removeEventListener("open", onOpen);
		ws.removeEventListener("error", onRejected);
		ws.removeEventListener("close", onRejected);
		if (ws.readyState === WebSocket.OPEN) ws.close();
		resolve(rejected);
	};
	const onOpen = () => finish(false);
	const onRejected = () => finish(true);
	ws.addEventListener("open", onOpen, { once: true });
	ws.addEventListener("error", onRejected, { once: true });
	ws.addEventListener("close", onRejected, { once: true });
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
			"GET /json/version HTTP/1.1\r\nHost: 192.0.2.1:12803\r\nConnection: close\r\n\r\n",
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe("ws://192.0.2.1:12803/cdp");
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

	it("listens on a non-loopback hostname while remaining reachable through loopback", async () => {
		relay = startRelayServer({ hostname: "0.0.0.0", port: 0 });
		const port = relay.port;
		const base = `http://127.0.0.1:${port}`;
		expect((await fetch(`${base}/capabilities`)).status).toBe(200);
		extension = await connectExtension(port);
		await waitForDiscovery(port);

		const host = "192.0.2.1:12803";
		const response = await fetch(`${base}/json/version`, { headers: { host } });
		expect(response.status).toBe(200);
		expect((await response.json()).webSocketDebuggerUrl).toBe(`ws://${host}/cdp`);
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
	it("controls tailnet exposure through the extension socket without disturbing loopback readiness", async () => {
		const port = await startReadyRelay();
		const base = `http://127.0.0.1:${port}`;

		const queried = await requestTailnetAccess(extension!, { requestId: 101 });
		expect(queried).toMatchObject({
			t: "tailnetAccessResult",
			requestId: 101,
			ok: true,
			enabled: false,
			port,
		});
		expect(Array.isArray(queried.tailnetAddresses)).toBeTrue();
		expect(queried.tailnetAddresses.every(address => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address))).toBeTrue();

		const enabled = await requestTailnetAccess(extension!, { requestId: 102, enabled: true });
		expect(enabled).toMatchObject({
			t: "tailnetAccessResult",
			requestId: 102,
			ok: true,
			enabled: true,
			port,
			tailnetAddresses: queried.tailnetAddresses,
		});
		const tailnetAddress = queried.tailnetAddresses[0];
		if (tailnetAddress !== undefined) {
			const remoteResponse = await fetch(`http://${tailnetAddress}:${port}/json/version`, {
				signal: AbortSignal.timeout(1_500),
			});
			expect(remoteResponse.status).toBe(200);
			expect(await extensionUpgradeIsRejected(tailnetAddress, port)).toBeTrue();
		}

		const nonTailnetResponse = await findNonTailnetResponse(port);
		if (nonTailnetResponse !== undefined) {
			expect(nonTailnetResponse.status).toBe(403);
			expect(await extensionUpgradeIsRejected(nonTailnetResponse.address, port)).toBeTrue();
		}

		const readyWhileEnabled = await (await fetch(`${base}/capabilities`)).json();
		expect(readyWhileEnabled.backend).toMatchObject({ ready: true, extensionSeen: true });

		const disabled = await requestTailnetAccess(extension!, { requestId: 103, enabled: false });
		expect(disabled).toMatchObject({
			t: "tailnetAccessResult",
			requestId: 103,
			ok: true,
			enabled: false,
			port,
			tailnetAddresses: queried.tailnetAddresses,
		});
		if (tailnetAddress !== undefined) {
			const remoteUnavailable = await fetch(`http://${tailnetAddress}:${port}/json/version`, {
				signal: AbortSignal.timeout(1_500),
			}).then(
				response => response.status !== 200,
				() => true,
			);
			expect(remoteUnavailable).toBeTrue();
		}

		const readyAfterDisable = await (await fetch(`${base}/capabilities`)).json();
		expect(readyAfterDisable.backend).toMatchObject({ ready: true, extensionSeen: true });
	});
});
