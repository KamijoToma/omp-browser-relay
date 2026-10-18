import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import puppeteer, { type Browser, type Target } from "puppeteer-core";
import { startRelayServer } from "../src/server";

/** Extra native APIs used only to simulate user actions in the isolated smoke browser. */
interface SmokeChromeApi extends ChromeApi {
	tabs: ChromeApi["tabs"] & {
		query(query: { windowId?: number; active?: boolean }): Promise<ChromeTab[]>;
		move(tabId: number, properties: { windowId: number; index: number }): Promise<ChromeTab>;
	};
	windows: ChromeApi["windows"] & {
		update(
			windowId: number,
			properties: { focused?: boolean; state?: "normal" | "minimized" },
		): Promise<ChromeWindow>;
		remove(windowId: number): Promise<void>;
	};
	debugger: ChromeApi["debugger"] & {
		getTargets(): Promise<Array<{ tabId?: number; attached: boolean }>>;
	};
}
declare const chrome: SmokeChromeApi;

const executable = process.env.PUPPETEER_EXECUTABLE_PATH ?? Bun.which("google-chrome") ?? Bun.which("chromium");
if (!executable) throw new Error("Set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium executable");
const headless = process.env.RELAY_SMOKE_HEADLESS === "1";
const nativeInput = process.env.RELAY_SMOKE_NATIVE_INPUT === "1";
const xdotool = process.env.RELAY_SMOKE_XDOTOOL ?? Bun.which("xdotool") ?? "";
if (nativeInput && (headless || !xdotool))
	throw new Error("Native input smoke requires a headed X11 display and xdotool");
const root = path.resolve(import.meta.dir, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-smoke-"));
const extensionDir = path.join(tmp, "extension");
const relay = startRelayServer({ port: 0 });
let externalClientReady = false;
const origin = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		if (new URL(request.url).pathname === "/__relay_smoke_client_ready" && request.method === "POST") {
			externalClientReady = true;
			return new Response("ready");
		}
		const title = new URL(request.url).pathname === "/user" ? "User page" : "Agent page";
		return new Response(
			`<!doctype html><meta charset="utf-8"><title>${title}</title>
<h1>${title}</h1><input id="field" autocomplete="off"><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Submit</button><output>idle</output>
<canvas width="300" height="160" style="display:block;border:1px solid #999;touch-action:none"></canvas>
${title === "User page" ? '<div style="height:2000px"></div>' : ""}
<script>
const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
let drawing = false;
context.strokeStyle = '#d22'; context.lineWidth = 4;
canvas.onpointerdown = event => { drawing=true; canvas.setPointerCapture(event.pointerId); context.beginPath(); context.moveTo(event.offsetX,event.offsetY); };
canvas.onpointermove = event => { if(drawing) { context.lineTo(event.offsetX,event.offsetY); context.stroke(); } };
canvas.onpointerup = () => { drawing=false; canvas.dataset.finished='yes'; };
if (document.title === 'User page') {
  let maximum = 0;
  addEventListener('scroll', () => {
    maximum = Math.max(maximum, scrollY);
    document.documentElement.dataset.maxScroll = String(maximum);
  });
}
</script>`,
			{ headers: { "Content-Type": "text/html; charset=utf-8" } },
		);
	},
});

function targetId(target: Target): string {
	if (!("_targetId" in target) || typeof target._targetId !== "string") {
		throw new Error("Puppeteer target has no CDP identity");
	}
	return target._targetId;
}

async function command(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const result = Promise.withResolvers<Record<string, unknown>>();
	const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/cdp`);
	const timer = setTimeout(() => result.reject(new Error(`${method} did not complete`)), 10_000);
	socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
	socket.onerror = () => result.reject(new Error(`${method} websocket failed`));
	socket.onmessage = event => {
		const response = JSON.parse(String(event.data));
		if (response.id !== 1) return;
		if (response.error) result.reject(new Error(response.error.message));
		else result.resolve(response.result);
	};
	try {
		return await result.promise;
	} finally {
		clearTimeout(timer);
		socket.close();
	}
}

let browserProcess: Browser | undefined;
let supervisor: Browser | undefined;
let workerClient: Browser | undefined;
let windowManager: Bun.Subprocess | undefined;
try {
	if (process.env.RELAY_SMOKE_WINDOW_MANAGER) {
		if (!xdotool || headless) throw new Error("A window-manager smoke requires headed X11 and xdotool");
		windowManager = Bun.spawn([process.env.RELAY_SMOKE_WINDOW_MANAGER, "--sm-disable"], {
			stdout: "ignore",
			stderr: "inherit",
		});
		const deadline = Date.now() + 5_000;
		let ready = false;
		while (Date.now() < deadline) {
			if (windowManager.exitCode !== null) throw new Error("Isolated window manager exited during startup");
			if ((await $`${xdotool} get_desktop`.quiet().nothrow()).exitCode === 0) {
				ready = true;
				break;
			}
			await Bun.sleep(20);
		}
		assert.ok(ready, "isolated window manager must establish its X11 desktop");
	}
	await $`bun ${path.join(root, "dist/cli.js")} install --dir ${extensionDir}`.quiet();
	// Change only the endpoint in this generated installation; never dial a user's default relay.
	const workerPath = path.join(extensionDir, "background.js");
	const generatedWorker = await Bun.file(workerPath).text();
	const configuredWorker = generatedWorker.replace("var DEFAULT_PORT = 9224;", `var DEFAULT_PORT = ${relay.port};`);
	if (configuredWorker === generatedWorker) throw new Error("Built worker has no configurable default relay port");
	await Bun.write(workerPath, configuredWorker);
	browserProcess = await puppeteer.launch({
		executablePath: executable,
		headless,
		defaultViewport: null,
		enableExtensions: [extensionDir],
		args: [
			"--no-sandbox",
			"--disable-dev-shm-usage",
			...(process.platform === "linux" && !headless ? ["--ozone-platform=x11"] : []),
		],
		userDataDir: path.join(tmp, "profile"),
		targetFilter: target => target.type() === "service_worker",
		waitForInitialPage: false,
		protocolTimeout: 10_000,
	});
	const workerTarget = await browserProcess.waitForTarget(
		target => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
	);
	const extension = await workerTarget.worker();
	assert.ok(extension, "extension service worker must start");
	const workerErrors: string[] = [];
	extension.on("error", error => {
		workerErrors.push(error.message);
	});
	await extension.evaluate(() => {
		const events: number[] = [];
		Object.assign(globalThis, { __relaySmokeFocusEvents: events });
		chrome.windows.onFocusChanged.addListener(windowId => {
			events.push(windowId);
		});
	});
	const base = `http://127.0.0.1:${origin.port}`;
	const userTab = await extension.evaluate(async url => chrome.tabs.create({ url, active: true }), `${base}/user`);
	assert.ok(userTab.id);
	const userId = userTab.id;
	const userWindow = userTab.windowId;
	let nativeUserWindow: string | undefined;
	if (nativeInput) {
		nativeUserWindow = (await $`${xdotool} search --sync --onlyvisible --name ${"^User page"}`.text())
			.trim()
			.split("\n")[0];
		assert.ok(nativeUserWindow, "the user browser window must be visible on the isolated X11 display");
		await $`${xdotool} windowactivate --sync ${nativeUserWindow}`.quiet();
	}
	const deadline = Date.now() + 10_000;
	while (!relay.bridge.ready && Date.now() < deadline) await Bun.sleep(20);
	if (!relay.bridge.ready) {
		const state = await extension.evaluate(
			"({connect:typeof connect, workspace:typeof workspace, socket:typeof ws === 'undefined' ? null : ws?.readyState})",
		);
		throw new Error(`Isolated extension did not connect: ${JSON.stringify({ state, workerErrors })}`);
	}
	const response = await fetch(`http://127.0.0.1:${relay.port}/json/version`, { proxy: false });
	assert.equal(response.status, 200);
	const discovery: unknown = await response.json();
	assert.ok(discovery !== null && typeof discovery === "object" && "ompRelay" in discovery);
	assert.deepEqual(discovery.ompRelay, { protocolVersion: 2, windowIsolation: "dedicated-window" });
	supervisor = await puppeteer.connect({
		browserWSEndpoint: `ws://127.0.0.1:${relay.port}/cdp`,
		defaultViewport: null,
		protocolTimeout: 10_000,
	});
	assert.equal(
		supervisor.targets().filter(target => target.type() === "page").length,
		0,
		"user tabs must not be exposed before a workspace exists",
	);
	const browserSession = await supervisor.target().createCDPSession();
	try {
		const { targetInfos } = await browserSession.send("Target.getTargets");
		assert.ok(
			targetInfos.every(target => target.type === "browser"),
			"browser sessions must not expose ordinary user tabs",
		);
	} finally {
		await browserSession.detach();
	}
	const first = await supervisor.newPage();
	await first.goto(`${base}/agent`);
	const firstTarget = targetId(first.target());
	workerClient = await puppeteer.connect({
		browserWSEndpoint: `ws://127.0.0.1:${relay.port}/cdp`,
		defaultViewport: null,
		protocolTimeout: 10_000,
	});
	const adopted = await workerClient.waitForTarget(
		target => target.type() === "page" && targetId(target) === firstTarget,
	);
	const agent = await adopted.page();
	assert.ok(agent);
	const workspaceTabs = await extension.evaluate(async () => chrome.tabs.query({}));
	const agentTab = workspaceTabs.find(tab => tab.url === `${base}/agent`);
	assert.ok(agentTab?.id);
	const agentWindow = agentTab.windowId;
	assert.notEqual(agentWindow, userWindow, "agent must get a separate window");
	const assertUserFocus = async () => {
		if (nativeUserWindow)
			assert.equal(
				(await $`${xdotool} getactivewindow`.text()).trim(),
				nativeUserWindow,
				"native input focus must stay on the user window",
			);
		const state = await extension.evaluate(
			async ({ userWindow, agentWindow }) => ({
				user: await chrome.windows.get(userWindow),
				agent: await chrome.windows.get(agentWindow),
				selected: await chrome.tabs.query({ windowId: userWindow, active: true }),
			}),
			{ userWindow, agentWindow },
		);
		assert.equal(state.user.focused, true, "user window must retain focus");
		assert.equal(state.agent.focused, false, "agent window must remain unfocused");
		assert.deepEqual(
			state.selected.map(tab => tab.id),
			[userId],
			"user's selected tab must not change",
		);
	};
	const assertNoAgentFocus = async () => {
		const events: unknown = await extension.evaluate("globalThis.__relaySmokeFocusEvents");
		assert.ok(Array.isArray(events));
		assert.ok(
			events.every(id => id === userWindow || id === -1),
			`Agent window stole native focus: ${JSON.stringify(events)}`,
		);
	};
	await assertUserFocus();
	const userAttached = await extension.evaluate(
		async id => (await chrome.debugger.getTargets()).find(target => target.tabId === id)?.attached,
		userId,
	);
	assert.equal(userAttached, false, "relay must not attach the user's ordinary tab");
	await agent.waitForSelector("canvas");
	const rect = await agent.$eval("canvas", canvas => {
		const box = canvas.getBoundingClientRect();
		return { x: box.left + canvas.clientLeft, y: box.top + canvas.clientTop };
	});
	// Native mode injects XTEST keyboard input into the currently focused window, never a target-window shortcut.
	await extension.evaluate(async id => {
		await chrome.debugger.attach({ tabId: id }, "1.3");
	}, userId);
	await extension.evaluate(async id => {
		await chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", {
			expression: "document.querySelector('#field').focus()",
		});
	}, userId);
	if (nativeInput)
		await extension.evaluate(async id => {
			await chrome.debugger.detach({ tabId: id });
		}, userId);
	await assertUserFocus();
	const pointerDown = Promise.withResolvers<void>();
	const userInputDone = Promise.withResolvers<void>();
	await Promise.all([
		(async () => {
			if (nativeInput) {
				await pointerDown.promise;
				const geometry = await $`${xdotool} getwindowgeometry --shell ${nativeUserWindow!}`.text();
				const width = Number(/WIDTH=(\d+)/.exec(geometry)?.[1]);
				const height = Number(/HEIGHT=(\d+)/.exec(geometry)?.[1]);
				assert.ok(width > 300 && height > 300, "foreground window must have a visible content area");
				await $`${xdotool} mousemove --window ${nativeUserWindow!} ${Math.floor(width / 2)} ${Math.floor(height / 2)}`.quiet();
				await $`${xdotool} click --repeat 3 --delay 50 5`.quiet();
				await $`${xdotool} type --clearmodifiers --delay 15 ${"USER_INPUT_ONLY"}`.quiet();
				userInputDone.resolve();
				return;
			}
			for (const text of ["USER_", "INPUT_", "ONLY"]) {
				await extension.evaluate(
					async ({ id, text }) => {
						await chrome.debugger.sendCommand({ tabId: id }, "Input.insertText", { text });
					},
					{ id: userId, text },
				);
				await Bun.sleep(30);
			}
			userInputDone.resolve();
		})(),
		(async () => {
			await agent.focus("#field");
			await assertUserFocus();
			await agent.keyboard.type("AGENT_INPUT_ONLY");
			await assertUserFocus();
			await agent.click("button");
			await assertUserFocus();
			await agent.mouse.move(rect.x + 20, rect.y + 20);
			await agent.mouse.down();
			pointerDown.resolve();
			await agent.mouse.move(rect.x + 140, rect.y + 80, { steps: 12 });
			await agent.mouse.move(rect.x + 220, rect.y + 120, { steps: 8 });
			await userInputDone.promise;
			await agent.mouse.up();
		})(),
	]);
	await assertUserFocus();
	if (nativeInput)
		await extension.evaluate(async id => {
			await chrome.debugger.attach({ tabId: id }, "1.3");
		}, userId);
	if (nativeInput)
		await extension.waitForFunction(
			async id => {
				const response = await chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", {
					expression: "document.querySelector('#field').value",
					returnByValue: true,
				});
				const result = response?.result;
				return (
					result !== null && typeof result === "object" && "value" in result && result.value === "USER_INPUT_ONLY"
				);
			},
			{ polling: 20, timeout: 5_000 },
			userId,
		);
	const foreground = await extension.evaluate(
		async id =>
			chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", {
				expression: "document.querySelector('#field').value",
				returnByValue: true,
			}),
		userId,
	);
	assert.ok(
		foreground && foreground.result !== null && typeof foreground.result === "object" && "value" in foreground.result,
	);
	assert.equal(foreground.result.value, "USER_INPUT_ONLY");
	if (nativeInput) {
		const scroll = await extension.evaluate(
			async id =>
				chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", {
					expression: "Number(document.documentElement.dataset.maxScroll ?? 0)",
					returnByValue: true,
				}),
			userId,
		);
		assert.ok(
			scroll?.result &&
				typeof scroll.result === "object" &&
				"value" in scroll.result &&
				typeof scroll.result.value === "number" &&
				scroll.result.value > 0,
			"real user wheel input must scroll user A while the agent holds its canvas pointer capture",
		);
		console.log("PASS: concurrent native mouse-wheel scrolling and keyboard input reached only user A");
	}
	await extension.evaluate(async id => {
		await chrome.debugger.detach({ tabId: id });
	}, userId);
	const result = await agent.evaluate(() => ({
		value: document.querySelector<HTMLInputElement>("#field")?.value,
		submitted: document.querySelector("output")?.textContent,
		finished: document.querySelector("canvas")?.dataset.finished,
		pixel: Array.from(document.querySelector("canvas")!.getContext("2d")!.getImageData(80, 50, 1, 1).data),
	}));
	assert.equal(result.value, "AGENT_INPUT_ONLY");
	assert.equal(result.submitted, "AGENT_INPUT_ONLY");
	assert.equal(result.finished, "yes");
	assert.deepEqual(result.pixel, [221, 34, 34, 255]);
	await assertUserFocus();
	const png = await agent.screenshot({ type: "png" });
	if (process.env.RELAY_SMOKE_SCREENSHOT) await Bun.write(process.env.RELAY_SMOKE_SCREENSHOT, png);
	await assertUserFocus();
	const second = await supervisor.newPage();
	await second.goto(`${base}/second`);
	await first.bringToFront();
	await assertUserFocus();
	await command("Target.activateTarget", { targetId: targetId(second.target()) });
	await assertUserFocus();
	await assertNoAgentFocus();
	console.log("PASS: background form, drawing, screenshot, tab selection, two-client multiplexing");
	if (process.env.RELAY_SMOKE_CLIENT) {
		const client = Bun.spawn(
			[process.execPath, path.resolve(process.env.RELAY_SMOKE_CLIENT), `http://127.0.0.1:${relay.port}`, base],
			{ stdout: "inherit", stderr: "inherit" },
		);
		let expectedUserValue = "USER_INPUT_ONLY";
		let nativeKeystrokes = 0;
		try {
			while (client.exitCode === null) {
				await assertUserFocus();
				await assertNoAgentFocus();
				// A real client announces when setup is complete, so these XTEST
				// keystrokes overlap browser operations, not dependency installation.
				if (nativeInput && externalClientReady) {
					await $`${xdotool} type --clearmodifiers ${"u"}`.quiet();
					expectedUserValue += "u";
					nativeKeystrokes++;
				}
				await Bun.sleep(20);
			}
			assert.equal(await client.exited, 0, "external browser client must complete successfully");
			await assertUserFocus();
			await assertNoAgentFocus();
			if (nativeInput && externalClientReady) {
				assert.ok(nativeKeystrokes > 0, "original client must overlap native user input");
				await extension.evaluate(async id => {
					await chrome.debugger.attach({ tabId: id }, "1.3");
				}, userId);
				try {
					const observed = await extension.evaluate(
						async id =>
							chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", {
								expression: "document.querySelector('#field').value",
								returnByValue: true,
							}),
						userId,
					);
					assert.ok(observed?.result && typeof observed.result === "object" && "value" in observed.result);
					assert.equal(
						observed.result.value,
						expectedUserValue,
						"native typing must reach only user A during original client operations",
					);
				} finally {
					await extension.evaluate(async id => {
						await chrome.debugger.detach({ tabId: id });
					}, userId);
				}
				console.log(
					`PASS: external client preserved user A focus and ${nativeKeystrokes} concurrent native keystrokes`,
				);
			}
		} finally {
			if (client.exitCode === null) client.kill();
			await client.exited;
		}
	}

	await extension.evaluate(async id => {
		await chrome.windows.update(id, { state: "normal", focused: true });
	}, agentWindow);
	await assert.rejects(
		agent.evaluate(() => {
			document.body.dataset.unwanted = "changed";
		}),
		/paused|user|workspace/i,
	);
	await extension.evaluate(async id => {
		await chrome.windows.update(id, { focused: true });
	}, userWindow);
	await extension.waitForFunction(
		id => {
			const events: unknown = Reflect.get(globalThis, "__relaySmokeFocusEvents");
			return Array.isArray(events) && events.at(-1) === id;
		},
		{ polling: 20, timeout: 5_000 },
		userWindow,
	);
	await extension.evaluate("globalThis.__relaySmokeFocusEvents.length = 0");
	await agent.evaluate(() => {
		document.body.dataset.resumed = "yes";
	});
	assert.equal(await agent.$eval("body", body => body.dataset.unwanted), undefined);
	assert.equal(await agent.$eval("body", body => body.dataset.resumed), "yes");
	await assertUserFocus();
	console.log("PASS: user takeover pauses control and leaving the workspace resumes it");

	const secondId = targetId(second.target());
	const secondTab = await extension.evaluate(
		async url => (await chrome.tabs.query({})).find(tab => tab.url === url),
		`${base}/second`,
	);
	assert.ok(secondTab?.id);
	await extension.evaluate(
		async ({ tabId, windowId }) => {
			await chrome.tabs.move(tabId, { windowId, index: -1 });
		},
		{ tabId: secondTab.id, windowId: userWindow },
	);
	const movedDeadline = Date.now() + 5_000;
	while (relay.bridge.listTargets().some(target => target.id === secondId) && Date.now() < movedDeadline)
		await Bun.sleep(20);
	assert.equal(
		relay.bridge.listTargets().some(target => target.id === secondId),
		false,
		"moved user tab must be retracted",
	);
	await assert.rejects(command("Target.attachToTarget", { targetId: secondId, flatten: true }));
	const attached = await extension.evaluate(
		async id => (await chrome.debugger.getTargets()).find(target => target.tabId === id)?.attached,
		secondTab.id,
	);
	assert.equal(attached, false, "moved tab must lose relay debugger attachment");
	console.log("PASS: moving a tab into the user window revokes relay access");

	await extension.evaluate(async id => {
		await chrome.windows.remove(id);
	}, agentWindow);
	const replacement = await supervisor.newPage();
	await replacement.goto(`${base}/replacement`);
	const replacementTab = await extension.evaluate(
		async url => (await chrome.tabs.query({})).find(tab => tab.url === url),
		`${base}/replacement`,
	);
	assert.ok(replacementTab);
	assert.notEqual(replacementTab.windowId, userWindow);
	assert.notEqual(replacementTab.windowId, agentWindow);
	assert.equal((await extension.evaluate(async id => chrome.windows.get(id), userWindow)).focused, true);
	assert.equal((await extension.evaluate(async id => chrome.windows.get(id), replacementTab.windowId)).focused, false);
	if (nativeUserWindow) assert.equal((await $`${xdotool} getactivewindow`.text()).trim(), nativeUserWindow);
	await assertNoAgentFocus();
	console.log("PASS: a closed workspace is replaced without adopting or focusing the user window");
	console.log(`SMOKE OK: ${await browserProcess.version()}`);
} finally {
	workerClient?.disconnect();
	supervisor?.disconnect();
	await browserProcess?.close();
	relay.stop();
	origin.stop(true);
	windowManager?.kill();
	await windowManager?.exited;
	await fs.rm(tmp, { recursive: true, force: true });
}
