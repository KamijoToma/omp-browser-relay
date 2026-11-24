import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

interface Call {
	method: string;
	params: Record<string, any>;
	sessionId?: string;
}
interface FakePage {
	id: string;
	type: string;
	title?: string;
	url?: string;
}
interface FakeRelayOptions {
	pages?: FakePage[];
	/** Result of Runtime.evaluate for an expression. */
	evaluate?: (expression: string) => unknown;
	/** Announce a file chooser after the first mouse press. */
	chooser?: boolean;
}

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

/** A relay stand-in that serves the discovery endpoints and records every CDP call the client sends. */
function fakeRelay(options: FakeRelayOptions = {}) {
	const calls: Call[] = [];
	const pages = options.pages ?? [
		{ id: "PAGE.1", type: "page", title: "Notebook", url: "https://app.test/notebook/1" },
	];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, bunServer) {
			const url = new URL(request.url);
			if (url.pathname === "/json/list") return Response.json(pages);
			if (url.pathname === "/json/version") {
				return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${bunServer.port}/cdp` });
			}
			if (url.pathname === "/cdp" && bunServer.upgrade(request)) return undefined;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, raw) {
				const message = JSON.parse(String(raw)) as { id: number } & Call;
				calls.push({ method: message.method, params: message.params, sessionId: message.sessionId });
				let result: Record<string, unknown> = {};
				if (message.method === "Target.attachToTarget") result = { sessionId: "S1" };
				if (message.method === "Runtime.evaluate") {
					result = { result: { value: options.evaluate?.(String(message.params.expression)) ?? null } };
				}
				if (message.method === "Page.captureScreenshot")
					result = { data: Buffer.from("PNGDATA").toString("base64") };
				socket.send(JSON.stringify({ id: message.id, result }));
				if (
					options.chooser &&
					message.method === "Input.dispatchMouseEvent" &&
					message.params.type === "mousePressed"
				) {
					socket.send(
						JSON.stringify({
							method: "Page.fileChooserOpened",
							sessionId: "S1",
							params: { mode: "selectMultiple", backendNodeId: 42 },
						}),
					);
				}
			},
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

async function client(relayUrl: string, ...args: string[]) {
	const child = Bun.spawn([process.execPath, CLI, "client", "--relay-url", relayUrl, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

const methods = (calls: Call[]): string[] => calls.map(call => call.method);
const mouseEvents = (calls: Call[]): Call[] => calls.filter(call => call.method === "Input.dispatchMouseEvent");

describe("relay client", () => {
	it("lists only pages and is reachable from the top-level help", async () => {
		const relay = fakeRelay({
			pages: [
				{ id: "PAGE.1", type: "page", title: "Notebook", url: "https://app.test/notebook/1" },
				{ id: "SW.1", type: "service_worker", url: "https://app.test/sw.js" },
			],
		});
		const result = await client(relay.url, "--list");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("PAGE.1\tNotebook\thttps://app.test/notebook/1");
		const help = Bun.spawn([process.execPath, CLI, "--help"], { stdout: "pipe" });
		expect(await new Response(help.stdout).text()).toContain("omp-browser-relay client");
		const clientHelp = await client(relay.url, "--help");
		expect(clientHelp.code).toBe(0);
		expect(clientHelp.stdout).toContain("uploadtext");
	});

	it("prefers an exact URL, then a page id, then a URL substring", async () => {
		const pages = [
			{ id: "B", type: "page", url: "https://app.test/a/b" },
			{ id: "A", type: "page", url: "https://app.test/a" },
		];
		for (const [target, expected] of [
			["https://app.test/a", "A"],
			["B", "B"],
			["/a/b", "B"],
		] as const) {
			const relay = fakeRelay({ pages });
			expect((await client(relay.url, target, "info")).code).toBe(0);
			expect(relay.calls.find(call => call.method === "Target.attachToTarget")?.params).toEqual({
				targetId: expected,
				flatten: true,
			});
		}
		const relay = fakeRelay({ pages });
		const missing = await client(relay.url, "https://other.test/", "info");
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('No relay page matches "https://other.test/"');
		expect(methods(relay.calls)).not.toContain("Target.attachToTarget");
	});

	it("reports an unreachable relay without a stack trace", async () => {
		const relay = fakeRelay();
		relay.stop();
		const result = await client(relay.url, "--list");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Cannot reach the relay");
		expect(result.stderr).not.toContain("    at ");
	});

	it("sends a trusted move, press and release at the requested coordinates", async () => {
		const relay = fakeRelay();
		const result = await client(relay.url, "PAGE.1", "click", "120", "45.5");
		expect(result.code).toBe(0);
		const events = mouseEvents(relay.calls);
		expect(events.map(call => call.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
		for (const call of events) {
			expect(call.params).toMatchObject({ x: 120, y: 45.5 });
			expect(call.sessionId).toBe("S1");
		}
		expect(events[1]!.params).toMatchObject({ button: "left", buttons: 1, clickCount: 1 });
		expect(methods(relay.calls).at(-1)).toBe("Target.detachFromTarget");

		const doubleRelay = fakeRelay();
		await client(doubleRelay.url, "PAGE.1", "dblclick", "1", "2");
		expect(mouseEvents(doubleRelay.calls).map(call => call.params.clickCount)).toEqual([undefined, 1, 1, 2, 2]);
	});

	it("clicks the centre of a control found by its visible text and fails when none is visible", async () => {
		const relay = fakeRelay({ evaluate: () => ({ x: 100, y: 50 }) });
		const result = await client(relay.url, "PAGE.1", "clicktext", "Add", "source");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('clicked "Add source" at 100,50');
		const lookup = relay.calls.find(call => call.method === "Runtime.evaluate");
		expect(lookup?.params.expression).toContain(JSON.stringify("Add source"));
		expect(mouseEvents(relay.calls)[1]!.params).toMatchObject({ x: 100, y: 50 });

		const none = fakeRelay({ evaluate: () => null });
		const failed = await client(none.url, "PAGE.1", "clicktext", "Missing");
		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain('No visible control with text "Missing"');
		expect(mouseEvents(none.calls)).toHaveLength(0);
	});

	it("inserts text and maps macOS editing shortcuts to editing commands", async () => {
		const relay = fakeRelay();
		expect((await client(relay.url, "PAGE.1", "type", "软件", "过程")).code).toBe(0);
		expect(relay.calls.find(call => call.method === "Input.insertText")?.params).toEqual({ text: "软件 过程" });

		const selectAll = fakeRelay();
		expect((await client(selectAll.url, "PAGE.1", "key", "Meta+a")).code).toBe(0);
		const keys = selectAll.calls.filter(call => call.method === "Input.dispatchKeyEvent");
		expect(keys.map(call => call.params.type)).toEqual(["rawKeyDown", "keyUp"]);
		expect(keys[0]!.params).toMatchObject({ key: "a", modifiers: 4, commands: ["selectAll"] });

		const enter = fakeRelay();
		await client(enter.url, "PAGE.1", "key", "Enter");
		expect(enter.calls.find(call => call.method === "Input.dispatchKeyEvent")?.params).toMatchObject({
			type: "keyDown",
			key: "Enter",
			text: "\r",
			modifiers: 0,
		});
	});

	it("captures screenshots at one image pixel per CSS pixel", async () => {
		const relay = fakeRelay({ evaluate: () => JSON.stringify({ width: 1456, height: 868, dpr: 2 }) });
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-client-shot-"));
		try {
			const output = path.join(directory, "page.png");
			const result = await client(relay.url, "PAGE.1", "shot", output);
			expect(result.code).toBe(0);
			expect(await Bun.file(output).text()).toBe("PNGDATA");
			expect(relay.calls.find(call => call.method === "Page.captureScreenshot")?.params.clip).toEqual({
				x: 0,
				y: 0,
				width: 1456,
				height: 868,
				scale: 0.5,
			});
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("selects files through an intercepted chooser and always releases the interception", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-client-upload-"));
		try {
			const first = path.join(directory, "a.pdf");
			const second = path.join(directory, "b.md");
			await Bun.write(first, "a");
			await Bun.write(second, "b");

			const relay = fakeRelay({ chooser: true });
			const result = await client(relay.url, "PAGE.1", "upload", "10", "20", first, second);
			expect(result.code).toBe(0);
			expect(result.stdout).toBe("chooser selectMultiple: set 2 file(s)");
			const intercepts = relay.calls.filter(call => call.method === "Page.setInterceptFileChooserDialog");
			expect(intercepts.map(call => call.params.enabled)).toEqual([true, false]);
			expect(relay.calls.find(call => call.method === "DOM.setFileInputFiles")?.params).toEqual({
				files: [first, second],
				backendNodeId: 42,
			});

			const silent = fakeRelay({ chooser: false });
			const none = await client(silent.url, "--chooser-timeout", "200", "PAGE.1", "upload", "10", "20", first);
			expect(none.code).toBe(3);
			expect(none.stderr).toContain("No file chooser opened");
			expect(methods(silent.calls)).not.toContain("DOM.setFileInputFiles");
			expect(
				silent.calls
					.filter(call => call.method === "Page.setInterceptFileChooserDialog")
					.map(call => call.params.enabled),
			).toEqual([true, false]);

			const text = fakeRelay({ chooser: true, evaluate: () => ({ x: 7, y: 8 }) });
			expect((await client(text.url, "PAGE.1", "uploadtext", "Upload files", first)).code).toBe(0);
			expect(mouseEvents(text.calls)[1]!.params).toMatchObject({ x: 7, y: 8 });
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects bad invocations before touching the page", async () => {
		const relay = fakeRelay({ chooser: true });
		for (const args of [
			["--list", "Notebook"],
			["--chooser-timeout", "0", "--list"],
			["--chooser-timeout"],
			["--unknown", "--list"],
			["PAGE.1"],
			["PAGE.1", "frobnicate"],
			["PAGE.1", "click", "1"],
			["PAGE.1", "click", "left", "1"],
			["PAGE.1", "key", "Hyper+a"],
			["PAGE.1", "key", "NoSuchKey"],
			["PAGE.1", "upload", "1", "2", "/nonexistent/file.pdf"],
		]) {
			const result = await client(relay.url, ...args);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("omp-browser-relay:");
		}
		expect(methods(relay.calls)).not.toContain("Input.dispatchMouseEvent");
		expect(methods(relay.calls)).not.toContain("Page.setInterceptFileChooserDialog");
	});
});
