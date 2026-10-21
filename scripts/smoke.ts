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
	throw new Error("Native input smoke requires a headed display and a native input helper");
const root = path.resolve(import.meta.dir, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-smoke-"));
const extensionDir = path.join(tmp, "extension");
const relay = startRelayServer({ port: 0 });
const origin = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		if (new URL(request.url).pathname === "/__relay_smoke_client_ready" && request.method === "POST") {
			return new Response("ready");
		}
		const pathname = new URL(request.url).pathname;
		if (pathname === "/interaction") {
			return new Response(
				`<!doctype html><meta charset="utf-8"><title>Generic interaction page</title>
<style>section{margin-block:16px}h2{font-size:1em}output{margin-inline:8px}</style>
<h1>Generic interactions</h1>
<section>
  <input id="label-control" type="checkbox" style="pointer-events:none">
  <label id="associated-label" for="label-control">Enable choice</label>
  <output id="label-state">Unchecked</output>Changes: <output id="label-count">0</output>
</section>
<section id="row-a">
  <h2>Record A</h2><label for="alias-a">Alias</label>
  <input id="alias-a" name="alias" autocomplete="off" value="A-seed"><button type="button">Save</button>
  <output data-save-state>Unchanged</output>Saves: <output data-save-count>0</output>
</section>
<section id="row-b">
  <h2>Record B</h2><label for="alias-b">Alias</label>
  <input id="alias-b" name="alias" autocomplete="off" value="B-seed"><button type="button">Save</button>
  <output data-save-state>Unchanged</output>Saves: <output data-save-count>0</output>
</section>
<section>
  <button id="step-one" type="button" aria-pressed="false">First step</button>
  <output id="step-one-state">Pending</output>Invocations: <output id="step-one-count">0</output>
</section>
<section>
  <button id="step-two" type="button" aria-pressed="false">Delayed second step</button>
  <output id="step-two-state">Pending</output>Invocations: <output id="step-two-count">0</output>
</section>
<section>
  <button id="step-three" type="button" aria-pressed="false">Third step</button>
  <output id="step-three-state">Pending</output>Invocations: <output id="step-three-count">0</output>
</section>
<script>
const control = document.querySelector('#label-control');
control.addEventListener('change', () => {
  document.querySelector('#label-state').textContent = control.checked ? 'Checked' : 'Unchecked';
  const count = document.querySelector('#label-count');
  count.textContent = String(Number(count.textContent) + 1);
});
for (const row of document.querySelectorAll('#row-a, #row-b')) {
  const input = row.querySelector('input[name="alias"]');
  let committedAlias = input.value;
  row.querySelector('button').addEventListener('click', () => {
    const count = row.querySelector('[data-save-count]');
    count.textContent = String(Number(count.textContent) + 1);
    row.querySelector('[data-save-state]').textContent = input.value !== committedAlias ? 'Saved' : 'Unchanged';
    committedAlias = input.value;
  });
}
for (const step of ['one', 'two', 'three']) {
  const button = document.querySelector('#step-' + step);
  button.addEventListener('click', () => {
    const count = document.querySelector('#step-' + step + '-count');
    count.textContent = String(Number(count.textContent) + 1);
    const complete = () => {
      button.setAttribute('aria-pressed', 'true');
      document.querySelector('#step-' + step + '-state').textContent = 'Completed';
    };
    if (step === 'two') setTimeout(complete, 150);
    else complete();
  });
}
</script>`,
				{ headers: { "Content-Type": "text/html; charset=utf-8" } },
			);
		}
		const title = pathname === "/user" ? "User page" : "Agent page";
		const seed = pathname === "/drag-in" ? "DRAGGED_STATE" : "";
		return new Response(
			`<!doctype html><meta charset="utf-8"><title>${title}</title>
<h1>${title}</h1><input id="field" autocomplete="off" value="${seed}"><button onclick="document.querySelector('output').textContent=document.querySelector('#field').value">Submit</button><output>idle</output>
<div><input id="cooperate" autocomplete="off"><button id="cooperate-submit" onclick="document.body.dataset.userClicks=String(Number(document.body.dataset.userClicks??0)+1)">User action</button></div>
<canvas width="300" height="160" style="display:block;border:1px solid #999;touch-action:none"></canvas>
<div style="height:2000px"></div>
<script>
const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
let drawing = false;
context.strokeStyle = '#d22'; context.lineWidth = 4;
canvas.onpointerdown = event => { drawing=true; canvas.setPointerCapture(event.pointerId); context.beginPath(); context.moveTo(event.offsetX,event.offsetY); };
canvas.onpointermove = event => { if(drawing) { context.lineTo(event.offsetX,event.offsetY); context.stroke(); } };
canvas.onpointerup = () => { drawing=false; canvas.dataset.finished='yes'; };
addEventListener('scroll', () => {
  document.documentElement.dataset.maxScroll = String(Math.max(Number(document.documentElement.dataset.maxScroll??0), scrollY));
});
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
			...(process.platform === "linux" && !headless
				? [`--ozone-platform=${process.env.RELAY_SMOKE_OZONE_PLATFORM ?? "x11"}`]
				: []),
		],
		userDataDir: path.join(tmp, "profile"),
		targetFilter: target => target.type() === "service_worker",
		waitForInitialPage: false,
		protocolTimeout: 10_000,
	});
	const workerTarget = await browserProcess.waitForTarget(
		target =>
			target.type() === "service_worker" &&
			target.url().startsWith("chrome-extension://") &&
			target.url().endsWith("/background.js"),
	);
	const extension = await workerTarget.worker();
	assert.ok(extension, "extension service worker must start");
	const workerErrors: string[] = [];
	extension.on("error", error => {
		workerErrors.push(error.message);
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
	const assertUserBoundary = async () => {
		const state = await extension.evaluate(
			async id => ({
				selected: await chrome.tabs.query({ windowId: id, active: true }),
				debugging: await chrome.debugger.getTargets(),
			}),
			userWindow,
		);
		assert.deepEqual(
			state.selected.map(tab => tab.id),
			[userId],
			"agent must not change another window's selected tab",
		);
		assert.equal(
			state.debugging.find(target => target.tabId === userId)?.attached,
			false,
			"relay must not attach an outside tab",
		);
		assert.equal(
			relay.bridge.listTargets().some(target => target.url === `${base}/user`),
			false,
			"outside pages must not be discoverable",
		);
	};
	const readUserValue = async () =>
		extension.evaluate(async id => {
			await chrome.debugger.attach({ tabId: id }, "1.3");
			try {
				const response = await chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", {
					expression: "document.querySelector('#field').value",
					returnByValue: true,
				});
				const result = response?.result;
				if (!result || typeof result !== "object" || !("value" in result) || typeof result.value !== "string")
					throw new Error("Outside-page observation failed");
				return result.value;
			} finally {
				await chrome.debugger.detach({ tabId: id });
			}
		}, userId);
	await assertUserBoundary();
	await agent.waitForSelector("canvas");
	const rect = await agent.$eval("canvas", canvas => {
		const box = canvas.getBoundingClientRect();
		return { x: box.left + canvas.clientLeft, y: box.top + canvas.clientTop };
	});
	// Establish user A's own state before automation. Window activation during agent input is explicitly allowed.
	await extension.evaluate(async id => {
		await chrome.debugger.attach({ tabId: id }, "1.3");
		await chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", {
			expression: "document.querySelector('#field').focus()",
		});
	}, userId);
	try {
		if (nativeInput) {
			await $`${xdotool} windowactivate --sync ${nativeUserWindow!}`.quiet();
			await $`${xdotool} type --clearmodifiers --delay 15 ${"USER_INPUT_ONLY"}`.quiet();
		} else {
			await extension.evaluate(async id => {
				await chrome.debugger.sendCommand({ tabId: id }, "Input.insertText", { text: "USER_INPUT_ONLY" });
			}, userId);
		}
		await extension.waitForFunction(
			async id => {
				const response = await chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", {
					expression: "document.querySelector('#field').value",
					returnByValue: true,
				});
				const result = response?.result;
				return !!result && typeof result === "object" && "value" in result && result.value === "USER_INPUT_ONLY";
			},
			{ polling: 20, timeout: 5_000 },
			userId,
		);
	} finally {
		await extension.evaluate(async id => {
			await chrome.debugger.detach({ tabId: id });
		}, userId);
	}
	await agent.focus("#field");
	await agent.keyboard.type("AGENT_INPUT_ONLY");
	await agent.click("button");
	await assertUserBoundary();
	await agent.mouse.move(rect.x + 20, rect.y + 20);
	await agent.mouse.down();
	try {
		await agent.mouse.move(rect.x + 140, rect.y + 80, { steps: 12 });
		await agent.screenshot({ type: "png" });
		await agent.mouse.move(rect.x + 220, rect.y + 120, { steps: 8 });
	} finally {
		await agent.mouse.up();
	}
	assert.equal(await readUserValue(), "USER_INPUT_ONLY", "agent commands must not write to an outside page");
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
	const selectedWork = await extension.evaluate(
		async id => (await chrome.tabs.query({ windowId: id })).filter(tab => tab.active),
		agentWindow,
	);
	assert.deepEqual(
		selectedWork.map(tab => tab.id),
		[agentTab.id],
		"drawing must leave the actual business page visible",
	);
	await assertUserBoundary();
	const png = await agent.screenshot({ type: "png" });
	if (process.env.RELAY_SMOKE_SCREENSHOT) await Bun.write(process.env.RELAY_SMOKE_SCREENSHOT, png);
	const second = await supervisor.newPage();
	await second.goto(`${base}/second`);
	await first.bringToFront();
	await command("Target.activateTarget", { targetId: targetId(second.target()) });
	await assertUserBoundary();
	console.log(
		"PASS: visible-page form, captured drawing with mid-drag screenshot, scoped selection and two-client multiplexing",
	);
	if (process.env.RELAY_SMOKE_CLIENT) {
		const client = Bun.spawn(
			[process.execPath, path.resolve(process.env.RELAY_SMOKE_CLIENT), `http://127.0.0.1:${relay.port}`, base],
			{ stdout: "inherit", stderr: "inherit" },
		);
		try {
			assert.equal(await client.exited, 0, "external browser client must complete successfully");
			await assertUserBoundary();
			assert.equal(await readUserValue(), "USER_INPUT_ONLY", "original client must not mutate an outside page");
		} finally {
			if (client.exitCode === null) client.kill();
			await client.exited;
		}
	}

	await first.bringToFront();
	await extension.evaluate(async id => {
		await chrome.windows.update(id, { state: "normal", focused: true });
	}, agentWindow);
	let nativeAgentWindow: string | undefined;
	if (nativeInput) {
		nativeAgentWindow = (await $`${xdotool} search --sync --onlyvisible --name ${"^Agent page"}`.text())
			.trim()
			.split("\n")[0];
		assert.ok(nativeAgentWindow);
		await $`${xdotool} windowactivate --sync ${nativeAgentWindow}`.quiet();
	}
	await agent.evaluate(() => {
		scrollTo(0, 0);
		document.documentElement.dataset.maxScroll = "0";
	});
	await agent.focus("#cooperate");
	await Promise.all([
		(async () => {
			if (nativeInput) {
				const geometry = await $`${xdotool} getwindowgeometry --shell ${nativeAgentWindow!}`.text();
				const width = Number(/WIDTH=(\d+)/.exec(geometry)?.[1]),
					height = Number(/HEIGHT=(\d+)/.exec(geometry)?.[1]);
				assert.ok(width > 300 && height > 300);
				await $`${xdotool} mousemove --window ${nativeAgentWindow!} ${Math.floor(width / 2)} ${Math.floor(height / 2)}`.quiet();
				await $`${xdotool} click --repeat 3 --delay 40 5`.quiet();
				await $`${xdotool} type --clearmodifiers --delay 20 ${"WORKSPACE_USER"}`.quiet();
				await $`${xdotool} key Tab Return`.quiet();
			} else {
				await agent.keyboard.type("WORKSPACE_USER");
				await agent.click("#cooperate-submit");
			}
		})(),
		(async () => {
			await agent.evaluate(() => {
				document.body.dataset.agentProgress = "started";
			});
			await agent.screenshot({ type: "png" });
			await agent.evaluate(() => {
				document.body.dataset.agentProgress = "finished";
			});
		})(),
	]);
	assert.equal(await agent.$eval("#cooperate", input => (input as HTMLInputElement).value), "WORKSPACE_USER");
	assert.equal(await agent.$eval("body", body => body.dataset.userClicks), "1");
	assert.equal(await agent.$eval("body", body => body.dataset.agentProgress), "finished");
	assert.equal((await extension.evaluate(async id => chrome.windows.get(id), agentWindow)).focused, true);
	if (nativeInput)
		assert.ok(
			(await agent.$eval("html", element => Number(element.dataset.maxScroll ?? "0"))) > 0,
			"native user wheel must operate the shared workspace",
		);
	console.log(
		"PASS: the focused workspace accepts real user interaction while agent evaluation and screenshots continue",
	);
	await assertUserBoundary();

	const incoming = await extension.evaluate(
		async ({ url, windowId }) => chrome.tabs.create({ url, windowId, active: false }),
		{ url: `${base}/drag-in`, windowId: userWindow },
	);
	assert.ok(incoming.id);
	assert.equal(
		relay.bridge.listTargets().some(target => target.url === `${base}/drag-in`),
		false,
	);
	await extension.evaluate(
		async ({ tabId, windowId }) => {
			await chrome.tabs.move(tabId, { windowId, index: -1 });
		},
		{ tabId: incoming.id, windowId: agentWindow },
	);
	const movedTarget = await supervisor.waitForTarget(
		target => target.type() === "page" && target.url() === `${base}/drag-in`,
	);
	const movedId = targetId(movedTarget);
	const movedPage = await movedTarget.page();
	assert.ok(movedPage);
	assert.equal(await movedPage.$eval("#field", input => (input as HTMLInputElement).value), "DRAGGED_STATE");
	await movedPage.focus("#field");
	await movedPage.keyboard.press("End");
	await movedPage.keyboard.type("_AGENT");
	assert.equal(await movedPage.$eval("#field", input => (input as HTMLInputElement).value), "DRAGGED_STATE_AGENT");
	await assertUserBoundary();
	await extension.evaluate(
		async ({ tabId, windowId }) => {
			await chrome.tabs.move(tabId, { windowId, index: -1 });
		},
		{ tabId: incoming.id, windowId: userWindow },
	);
	const movedDeadline = Date.now() + 5_000;
	while (relay.bridge.listTargets().some(target => target.id === movedId) && Date.now() < movedDeadline)
		await Bun.sleep(20);
	assert.equal(
		relay.bridge.listTargets().some(target => target.id === movedId),
		false,
	);
	await assert.rejects(command("Target.attachToTarget", { targetId: movedId, flatten: true }));
	await assert.rejects(
		movedPage.evaluate(() => {
			document.body.dataset.outsideWrite = "forbidden";
		}),
	);
	assert.equal(
		await extension.evaluate(
			async id => (await chrome.debugger.getTargets()).find(target => target.tabId === id)?.attached,
			incoming.id,
		),
		false,
	);
	// Restoring a selection after the simulated user move is a test action, never relay recovery.
	await extension.evaluate(async id => {
		await chrome.tabs.update(id, { active: true });
	}, userId);
	await assertUserBoundary();
	console.log("PASS: a pre-existing tab is adopted on move-in with state preserved and loses control on move-out");

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
	await assertUserBoundary();
	console.log("PASS: a closed workspace is replaced without adopting outside pages");
	await replacement.close();
	const afterLastClose = await supervisor.newPage();
	await afterLastClose.goto(`${base}/after-last-close`);
	assert.equal(await afterLastClose.$eval("title", title => title.textContent), "Agent page");
	await assertUserBoundary();
	console.log(
		"PASS: closing the last business page acknowledges successfully and the next page gets a fresh workspace",
	);
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
