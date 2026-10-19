import { describe, expect, test } from "bun:test";
import { Workspace } from "../extension/workspace";
import type { ExtToRelayMessage, TabSnapshot } from "../src/protocol";

class Event<Args extends unknown[]> {
	#listeners = new Set<(...args: Args) => void>();
	addListener(listener: (...args: Args) => void): void {
		this.#listeners.add(listener);
	}
	removeListener(listener: (...args: Args) => void): void {
		this.#listeners.delete(listener);
	}
	emit(...args: Args): void {
		for (const listener of this.#listeners) listener(...args);
	}
}

function harness(session: Record<string, unknown> = {}) {
	const tabs = new Map<number, ChromeTab>([[1, { id: 1, windowId: 10, active: true, url: "https://user.example" }]]);
	const windows = new Map<number, ChromeWindow>([[10, { id: 10, focused: true, type: "normal" }]]);
	const events = {
		created: new Event<[ChromeTab]>(),
		updated: new Event<[number, ChromeTabChangeInfo, ChromeTab]>(),
		removed: new Event<[number, { windowId: number; isWindowClosing: boolean }]>(),
		detached: new Event<[number, { oldWindowId: number; oldPosition: number }]>(),
		joined: new Event<[number, { newWindowId: number; newPosition: number }]>(),
		activated: new Event<[{ tabId: number; windowId: number }]>(),
		focus: new Event<[number]>(),
		windowRemoved: new Event<[number]>(),
		debuggerEvent: new Event<[ChromeDebuggerSession, string, Record<string, unknown>?]>(),
		debuggerDetach: new Event<[ChromeDebuggerSession, string]>(),
	};
	const attached = new Set<number>(),
		emulated = new Map<number, boolean>();
	const messages: ExtToRelayMessage[] = [];
	const creations: Array<{ url: string; focused: boolean; type: "normal" }> = [];
	const selections: number[] = [],
		removals: number[] = [];
	const commands: Array<{ target: ChromeDebuggerSession; method: string; params?: Record<string, unknown> }> = [];
	const dispatches: Array<{ tabId: number; method: string; active: boolean; emulated: boolean }> = [];
	let nextTab = 2,
		nextWindow = 20;
	let createGate: Promise<void> | undefined, attachGate: Promise<void> | undefined;
	const api: ChromeApi = {
		tabs: {
			async query(query) {
				return [...tabs.values()]
					.filter(tab => query.windowId === undefined || tab.windowId === query.windowId)
					.map(tab => ({ ...tab }));
			},
			async get(id) {
				const tab = tabs.get(id);
				if (!tab) throw new Error("No tab");
				return { ...tab };
			},
			async create(properties) {
				if (properties.windowId === undefined || !windows.has(properties.windowId))
					throw new Error("Explicit existing window required");
				const tab: ChromeTab = {
					id: nextTab++,
					windowId: properties.windowId,
					url: properties.url,
					active: properties.active ?? true,
					discarded: false,
				};
				if (tab.active)
					for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
				tabs.set(tab.id!, tab);
				events.created.emit({ ...tab });
				if (tab.active) events.activated.emit({ tabId: tab.id!, windowId: tab.windowId });
				return { ...tab };
			},
			async update(id, properties) {
				const tab = tabs.get(id);
				if (!tab) throw new Error("No tab");
				if (properties.active && emulated.get(id)) throw new Error("Native selection activated an emulated widget");
				if (properties.active)
					for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
				tab.active = properties.active ?? tab.active;
				selections.push(id);
				if (tab.active && tab.discarded) {
					tab.discarded = false;
					events.updated.emit(id, { discarded: false }, { ...tab });
				}
				if (tab.active) events.activated.emit({ tabId: id, windowId: tab.windowId });
				return { ...tab };
			},
			async remove(id) {
				const tab = tabs.get(id);
				if (!tab) throw new Error("No tab");
				removals.push(id);
				tabs.delete(id);
				events.removed.emit(id, { windowId: tab.windowId, isWindowClosing: false });
			},
			onCreated: events.created,
			onUpdated: events.updated,
			onRemoved: events.removed,
			onDetached: events.detached,
			onAttached: events.joined,
			onActivated: events.activated,
		},
		windows: {
			WINDOW_ID_NONE: -1,
			async get(id) {
				const window = windows.get(id);
				if (!window) throw new Error("No window");
				return { ...window };
			},
			async create(properties) {
				creations.push(properties);
				if (createGate) await createGate;
				const window = { id: nextWindow++, focused: properties.focused, type: properties.type };
				windows.set(window.id, window);
				await api.tabs.create({ windowId: window.id, url: properties.url });
				return window;
			},
			onFocusChanged: events.focus,
			onRemoved: events.windowRemoved,
		},
		debugger: {
			async attach(target) {
				if (attachGate) await attachGate;
				if (target.tabId === undefined) throw new Error("No tab");
				attached.add(target.tabId);
			},
			async detach(target) {
				if (target.tabId !== undefined) {
					attached.delete(target.tabId);
					emulated.delete(target.tabId);
				}
				events.debuggerDetach.emit(target, "canceled_by_user");
			},
			async sendCommand(target, method, params) {
				commands.push({ target, method, params });
				if (target.tabId !== undefined) {
					const tab = tabs.get(target.tabId);
					if (!tab) throw new Error("No tab");
					if (method === "Emulation.setFocusEmulationEnabled")
						emulated.set(target.tabId, params?.enabled === true);
					else
						dispatches.push({
							tabId: target.tabId,
							method,
							active: tab.active,
							emulated: emulated.get(target.tabId) ?? false,
						});
				}
				return method === "Target.getTargetInfo"
					? { targetInfo: { targetId: `real-${target.tabId}` } }
					: { result: "ok" };
			},
			onEvent: events.debuggerEvent,
			onDetach: events.debuggerDetach,
		},
		storage: {
			local: {
				async get(defaults) {
					return defaults;
				},
				async set() {},
			},
			session: {
				async get(defaults) {
					return { ...defaults, ...session };
				},
				async set(items) {
					Object.assign(session, items);
				},
			},
			onChanged: new Event<[Record<string, ChromeStorageChange>, string]>(),
		},
		alarms: { async create() {}, onAlarm: new Event<[{ name: string }]>() },
		action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, onClicked: new Event<[ChromeTab]>() },
		runtime: {
			getURL(path) {
				return `chrome-extension://relay/${path}`;
			},
			async openOptionsPage() {},
			async sendMessage() {
				return {};
			},
			onMessage: new Event<[unknown, { url?: string }, (response: Record<string, unknown>) => void]>(),
			onInstalled: new Event<[]>(),
			onStartup: new Event<[]>(),
		},
	};
	const workspace = new Workspace(api, message => messages.push(message));
	return {
		api,
		workspace,
		tabs,
		windows,
		events,
		commands,
		dispatches,
		attached,
		emulated,
		messages,
		creations,
		selections,
		removals,
		session,
		setCreateGate(gate: Promise<void>) {
			createGate = gate;
		},
		setAttachGate(gate: Promise<void>) {
			attachGate = gate;
		},
		focus(id: number) {
			for (const window of windows.values()) window.focused = window.id === id;
			events.focus.emit(id);
		},
		move(id: number, windowId: number) {
			const tab = tabs.get(id);
			if (!tab) throw new Error("No tab");
			const oldWindowId = tab.windowId;
			tab.windowId = windowId;
			events.detached.emit(id, { oldWindowId, oldPosition: 0 });
			events.joined.emit(id, { newWindowId: windowId, newPosition: 0 });
		},
	};
}

async function create(workspace: Workspace, url = "about:blank"): Promise<TabSnapshot> {
	return ((await workspace.runRpc({ op: "createTab", url })) as { tab: TabSnapshot }).tab;
}
async function settle(): Promise<void> {
	const pending = Promise.withResolvers<void>();
	setImmediate(pending.resolve);
	await pending.promise;
}
function blockCommand(api: ChromeApi, method: string) {
	const entered = Promise.withResolvers<void>(),
		finished = Promise.withResolvers<void>();
	const send = api.debugger.sendCommand;
	api.debugger.sendCommand = async (target, current, params) => {
		const result = await send(target, current, params);
		if (current === method) {
			entered.resolve();
			await finished.promise;
		}
		return result;
	};
	return { entered: entered.promise, finish: finished.resolve };
}

describe("shared-control workspace", () => {
	test("ordinary windows are neither discovered nor controllable", async () => {
		const h = harness();
		expect(await h.workspace.hello("install", "Chrome/150")).toMatchObject({ workspaceWindowId: null, tabs: [] });
		for (const op of ["attach", "activateTab", "removeTab"] as const)
			await expect(h.workspace.runRpc({ op, tabId: 1 })).rejects.toThrow("not in the dedicated");
		expect(h.attached.has(1)).toBe(false);
		expect(h.removals).toEqual([]);
		expect(h.tabs.get(1)?.active).toBe(true);
	});

	test("concurrent first creates share a window and select only requested business pages", async () => {
		const h = harness(),
			gate = Promise.withResolvers<void>();
		h.setCreateGate(gate.promise);
		const first = create(h.workspace, "https://work.example/a"),
			second = create(h.workspace, "https://work.example/b");
		await settle();
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(a.windowId).toBe(b.windowId);
		expect(a.tabId).not.toBe(b.tabId);
		expect(h.creations).toEqual([{ url: "https://work.example/a", focused: false, type: "normal" }]);
		expect([...h.tabs.values()].filter(tab => tab.windowId === a.windowId).map(tab => tab.url)).toEqual([
			"https://work.example/a",
			"https://work.example/b",
		]);
		expect(h.tabs.get(b.tabId)?.active).toBe(true);
		expect(h.windows.get(10)?.focused).toBe(true);
		expect(h.tabs.get(1)?.active).toBe(true);
	});

	test("focused users can coexist with input, page creation, and removal", async () => {
		const h = harness(),
			a = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		h.focus(a.windowId);
		await h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Runtime.evaluate" });
		await h.workspace.runRpc({
			op: "send",
			tabId: a.tabId,
			method: "Input.dispatchMouseEvent",
			params: { type: "mousePressed", x: 20, y: 20, button: "left" },
		});
		const b = await create(h.workspace);
		await h.workspace.runRpc({ op: "removeTab", tabId: b.tabId });
		expect(h.tabs.has(a.tabId)).toBe(true);
		expect(h.tabs.has(b.tabId)).toBe(false);
		expect(h.windows.get(a.windowId)?.focused).toBe(true);
		expect(h.dispatches.find(command => command.method === "Input.dispatchMouseEvent")).toMatchObject({
			active: true,
			emulated: false,
		});
	});

	test("input and captures leave the operated business page selected without affecting another window", async () => {
		const h = harness(),
			a = await create(h.workspace),
			b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		for (const method of [
			"Runtime.evaluate",
			"Input.dispatchKeyEvent",
			"Input.dispatchMouseEvent",
			"Page.captureScreenshot",
			"Page.startScreencast",
		]) {
			await h.workspace.runRpc({ op: "send", tabId: a.tabId, method });
			expect(h.tabs.get(a.tabId)?.active).toBe(true);
			expect(h.tabs.get(b.tabId)?.active).toBe(false);
			expect(h.dispatches.at(-1)).toMatchObject({ tabId: a.tabId, active: true, emulated: false });
		}
		expect(h.windows.get(10)?.focused).toBe(true);
		expect(h.tabs.get(1)?.active).toBe(true);
	});

	test("stock focus requests cannot emulate a native widget or change selection", async () => {
		const h = harness(),
			a = await create(h.workspace),
			b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		for (const enabled of [true, false, true])
			await h.workspace.runRpc({
				op: "send",
				tabId: a.tabId,
				method: "Emulation.setFocusEmulationEnabled",
				params: { enabled },
			});
		expect(h.emulated.get(a.tabId)).toBe(false);
		expect(h.tabs.get(b.tabId)?.active).toBe(true);
		expect(h.tabs.get(1)?.active).toBe(true);
		await expect(
			h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Emulation.setFocusEmulationEnabled", params: {} }),
		).rejects.toThrow("boolean");
	});

	test("global commands and forged target ids cannot escape an owned tab", async () => {
		const h = harness(),
			a = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		for (const method of [
			"Browser.close",
			"Browser.setWindowBounds",
			"Browser.grantPermissions",
			"Target.createTarget",
			"Target.createBrowserContext",
			"Page.setDownloadBehavior",
		])
			await expect(h.workspace.runRpc({ op: "send", tabId: a.tabId, method })).rejects.toThrow("Unsupported");
		await expect(
			h.workspace.runRpc({
				op: "send",
				tabId: a.tabId,
				method: "Target.activateTarget",
				params: { targetId: "foreign" },
			}),
		).rejects.toThrow("not owned");
		await expect(
			h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Target.setAutoAttach", params: { flatten: false } }),
		).rejects.toThrow("flat child");
		expect(h.tabs.get(1)?.active).toBe(true);
		expect(h.attached.has(1)).toBe(false);
	});

	test("child sessions stay under their owned root and cannot manipulate another target", async () => {
		const h = harness(),
			a = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		h.events.debuggerEvent.emit({ tabId: a.tabId }, "Target.attachedToTarget", {
			sessionId: "child",
			targetInfo: { targetId: "frame-target" },
		});
		await settle();
		await h.workspace.runRpc({ op: "send", tabId: a.tabId, sessionId: "child", method: "Input.dispatchMouseEvent" });
		await expect(
			h.workspace.runRpc({ op: "send", tabId: a.tabId, sessionId: "other", method: "Runtime.evaluate" }),
		).rejects.toThrow("Unknown workspace child");
		await expect(
			h.workspace.runRpc({
				op: "send",
				tabId: a.tabId,
				sessionId: "child",
				method: "Emulation.setFocusEmulationEnabled",
				params: { enabled: true },
			}),
		).rejects.toThrow("workspace page");
		await expect(
			h.workspace.runRpc({
				op: "send",
				tabId: a.tabId,
				method: "Target.detachFromTarget",
				params: { sessionId: "foreign" },
			}),
		).rejects.toThrow("Unknown workspace child");
		h.move(a.tabId, 10);
		await settle();
		await expect(
			h.workspace.runRpc({ op: "send", tabId: a.tabId, sessionId: "child", method: "Runtime.evaluate" }),
		).rejects.toThrow("not in the dedicated");
	});

	test("moving an existing user page in grants control and moving it out revokes it", async () => {
		const h = harness(),
			a = await create(h.workspace);
		h.move(1, a.windowId);
		await settle();
		const hello = await h.workspace.hello("install", "Chrome/150");
		if (hello.t !== "hello") throw new Error("Expected hello");
		expect(hello.tabs.map(tab => tab.tabId).sort()).toEqual([1, a.tabId].sort());
		await h.workspace.runRpc({ op: "attach", tabId: 1 });
		await h.workspace.runRpc({ op: "send", tabId: 1, method: "Runtime.evaluate" });
		expect(h.attached.has(1)).toBe(true);
		h.move(1, 10);
		await settle();
		expect(h.attached.has(1)).toBe(false);
		await expect(h.workspace.runRpc({ op: "send", tabId: 1, method: "Runtime.evaluate" })).rejects.toThrow(
			"not in the dedicated",
		);
		expect(h.messages).toContainEqual({ t: "tabRemoved", tabId: 1 });
	});

	test("late move-in lookup cannot re-advertise a tab after it moved back out", async () => {
		const h = harness(),
			a = await create(h.workspace),
			delayed = Promise.withResolvers<ChromeTab>();
		const get = h.api.tabs.get;
		h.api.tabs.get = id => (id === 1 ? delayed.promise : get(id));
		h.move(1, a.windowId);
		const incoming = { ...h.tabs.get(1)! };
		h.move(1, 10);
		delayed.resolve(incoming);
		await settle();
		expect(h.messages.filter(message => message.t === "tabCreated" && message.tab.tabId === 1)).toEqual([]);
	});

	test("fresh ownership checks reject a moved tab even when Chrome migration events were missed", async () => {
		const h = harness(),
			a = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		h.tabs.get(a.tabId)!.windowId = 10;
		await expect(
			h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Input.dispatchKeyEvent" }),
		).rejects.toThrow("not in the dedicated");
		await expect(h.workspace.runRpc({ op: "removeTab", tabId: a.tabId })).rejects.toThrow("not in the dedicated");
		await settle();
		expect(h.attached.has(a.tabId)).toBe(false);
		expect(h.removals).toEqual([]);
	});

	test("ownership is rechecked after asynchronous window lookup before attach or input", async () => {
		for (const operation of ["attach", "send"] as const) {
			const h = harness(),
				a = await create(h.workspace);
			if (operation === "send") await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
			const entered = Promise.withResolvers<void>(),
				finish = Promise.withResolvers<void>(),
				get = h.api.windows.get;
			h.api.windows.get = async id => {
				const window = await get(id);
				entered.resolve();
				await finish.promise;
				return window;
			};
			const pending = h.workspace.runRpc(
				operation === "attach"
					? { op: "attach", tabId: a.tabId }
					: { op: "send", tabId: a.tabId, method: "Input.dispatchKeyEvent" },
			);
			const rejected = pending.then(
				() => false,
				() => true,
			);
			await entered.promise;
			h.move(a.tabId, 10);
			finish.resolve();
			expect(await rejected).toBe(true);
			await settle();
			expect(h.attached.has(a.tabId)).toBe(false);
			expect(h.dispatches.filter(command => command.method === "Input.dispatchKeyEvent")).toEqual([]);
		}
	});

	test("discarded pages remain discoverable but cannot attach until native selection revives them", async () => {
		const h = harness(),
			a = await create(h.workspace);
		await create(h.workspace);
		h.tabs.get(a.tabId)!.discarded = true;
		const hello = await h.workspace.hello("install", "Chrome/150");
		if (hello.t !== "hello") throw new Error("Expected hello");
		expect(hello.tabs.find(tab => tab.tabId === a.tabId)?.discarded).toBe(true);
		await expect(h.workspace.runRpc({ op: "attach", tabId: a.tabId })).rejects.toThrow("discarded");
		await h.workspace.runRpc({ op: "activateTab", tabId: a.tabId });
		expect(h.tabs.get(a.tabId)?.discarded).toBe(false);
		expect(h.attached.has(a.tabId)).toBe(false);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		expect(h.attached.has(a.tabId)).toBe(true);
	});

	test("discarding during a native attach retracts the late attachment", async () => {
		const h = harness(),
			a = await create(h.workspace),
			gate = Promise.withResolvers<void>();
		h.setAttachGate(gate.promise);
		const pending = h.workspace.runRpc({ op: "attach", tabId: a.tabId }).then(
			() => false,
			() => true,
		);
		await settle();
		h.tabs.get(a.tabId)!.discarded = true;
		h.events.updated.emit(a.tabId, { discarded: true }, { ...h.tabs.get(a.tabId)! });
		gate.resolve();
		expect(await pending).toBe(true);
		expect(h.attached.has(a.tabId)).toBe(false);
		expect(h.emulated.get(a.tabId)).not.toBe(true);
	});

	test("an awaited page promise does not block input, cancellation, or another page's removal", async () => {
		const h = harness(),
			a = await create(h.workspace),
			b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		const blocked = blockCommand(h.api, "Runtime.evaluate");
		const pending = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Runtime.evaluate" });
		await blocked.entered;
		await h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Input.dispatchMouseEvent" });
		await h.workspace.runRpc({ op: "removeTab", tabId: b.tabId });
		expect(h.tabs.has(b.tabId)).toBe(false);
		blocked.finish();
		await pending;
	});

	test("capture selection is serialized, while cleanup can bypass a blocked capture", async () => {
		const h = harness(),
			a = await create(h.workspace),
			b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		await h.workspace.runRpc({ op: "attach", tabId: b.tabId });
		const blocked = blockCommand(h.api, "Page.captureScreenshot"),
			capture = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Page.captureScreenshot" });
		await blocked.entered;
		const input = h.workspace.runRpc({ op: "send", tabId: b.tabId, method: "Input.dispatchMouseEvent" });
		await settle();
		expect(h.tabs.get(a.tabId)?.active).toBe(true);
		expect(h.dispatches.filter(command => command.method === "Input.dispatchMouseEvent")).toEqual([]);
		await h.workspace.runRpc({
			op: "send",
			tabId: a.tabId,
			method: "Page.handleJavaScriptDialog",
			params: { accept: true },
		});
		await h.workspace.runRpc({
			op: "send",
			tabId: a.tabId,
			method: "Fetch.continueRequest",
			params: { requestId: "request" },
		});
		await h.workspace.runRpc({
			op: "send",
			tabId: a.tabId,
			method: "Emulation.setFocusEmulationEnabled",
			params: { enabled: false },
		});
		expect(h.tabs.get(a.tabId)?.active).toBe(true);
		blocked.finish();
		await Promise.all([capture, input]);
		expect(h.tabs.get(b.tabId)?.active).toBe(true);
	});

	test("user tab selection during capture is not undone by late capture completion", async () => {
		const h = harness(),
			a = await create(h.workspace),
			b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		const blocked = blockCommand(h.api, "Page.captureScreenshot"),
			capture = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Page.captureScreenshot" });
		await blocked.entered;
		await h.api.tabs.update(b.tabId, { active: true });
		h.focus(a.windowId);
		blocked.finish();
		await capture;
		expect(h.tabs.get(b.tabId)?.active).toBe(true);
		expect(h.windows.get(a.windowId)?.focused).toBe(true);
		await h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Input.dispatchMouseEvent" });
		expect(h.tabs.get(a.tabId)?.active).toBe(true);
	});

	test("migration cancels a pending capture and its completion never selects the moved user's page", async () => {
		const h = harness(),
			a = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		const blocked = blockCommand(h.api, "Page.captureScreenshot"),
			capture = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Page.captureScreenshot" }).then(
				() => false,
				() => true,
			);
		await blocked.entered;
		h.move(a.tabId, 10);
		expect(await capture).toBe(true);
		const selections = [...h.selections];
		blocked.finish();
		await settle();
		expect(h.selections).toEqual(selections);
		expect(h.attached.has(a.tabId)).toBe(false);
	});

	test("detach and disconnect cancel blocked captures and stale queued input", async () => {
		for (const release of ["detach", "disconnect"] as const) {
			const h = harness(),
				a = await create(h.workspace),
				b = await create(h.workspace);
			await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
			const blocked = blockCommand(h.api, "Page.captureScreenshot"),
				capture = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Page.captureScreenshot" }).then(
					() => false,
					() => true,
				);
			await blocked.entered;
			const queued = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Input.dispatchKeyEvent" }).then(
				() => false,
				() => true,
			);
			if (release === "detach") await h.workspace.runRpc({ op: "detach", tabId: a.tabId });
			else await h.workspace.releaseAll();
			expect(await capture).toBe(true);
			expect(await queued).toBe(true);
			await h.api.tabs.update(b.tabId, { active: true });
			blocked.finish();
			await settle();
			expect(h.tabs.get(b.tabId)?.active).toBe(true);
			expect(h.dispatches.filter(command => command.method === "Input.dispatchKeyEvent")).toEqual([]);
		}
	});

	test("cancellation does not let later input overtake an already dispatched native selection", async () => {
		const h = harness(),
			a = await create(h.workspace),
			b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		const entered = Promise.withResolvers<void>(),
			finish = Promise.withResolvers<void>(),
			update = h.api.tabs.update;
		h.api.tabs.update = async (id, properties) => {
			if (id === a.tabId) {
				entered.resolve();
				await finish.promise;
			}
			return update(id, properties);
		};
		const old = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Input.dispatchKeyEvent" }).then(
			() => false,
			() => true,
		);
		await entered.promise;
		await h.workspace.releaseAll();
		const next = h.workspace.runRpc({ op: "attach", tabId: b.tabId });
		await settle();
		expect(h.attached.has(b.tabId)).toBe(false);
		finish.resolve();
		expect(await old).toBe(true);
		await next;
		await h.workspace.runRpc({ op: "send", tabId: b.tabId, method: "Input.dispatchMouseEvent" });
		expect(h.tabs.get(b.tabId)?.active).toBe(true);
	});

	test("disconnect during native attach releases its late attachment", async () => {
		const h = harness(),
			a = await create(h.workspace),
			gate = Promise.withResolvers<void>();
		h.setAttachGate(gate.promise);
		const pending = h.workspace.runRpc({ op: "attach", tabId: a.tabId }).then(
			() => false,
			() => true,
		);
		await settle();
		const release = h.workspace.releaseAll();
		gate.resolve();
		expect(await pending).toBe(true);
		await release;
		expect(h.attached.has(a.tabId)).toBe(false);
	});

	test("a failed capture preserves its real error without selecting another page", async () => {
		const h = harness(),
			a = await create(h.workspace),
			b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		const send = h.api.debugger.sendCommand;
		h.api.debugger.sendCommand = async (target, method, params) => {
			if (method === "Page.captureScreenshot") {
				await h.api.tabs.update(b.tabId, { active: true });
				throw new Error("Capture failed");
			}
			return send(target, method, params);
		};
		await expect(
			h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Page.captureScreenshot" }),
		).rejects.toThrow("Capture failed");
		expect(h.tabs.get(b.tabId)?.active).toBe(true);
	});

	test("window closure retires identity before the final window-removed event", async () => {
		const h = harness(),
			a = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		h.events.removed.emit(a.tabId, { windowId: a.windowId, isWindowClosing: true });
		const b = await create(h.workspace, "https://replacement.example");
		expect(b.windowId).not.toBe(a.windowId);
		expect(b.windowId).not.toBe(10);
		expect(b.url).toBe("https://replacement.example");
		expect(h.attached.has(a.tabId)).toBe(false);
		expect(h.tabs.get(1)?.active).toBe(true);
	});

	test("fresh-page creation recovers a closed window before its removal notification arrives", async () => {
		const h = harness(),
			old = await create(h.workspace);
		h.windows.delete(old.windowId);
		h.tabs.delete(old.tabId);
		const fresh = await create(h.workspace, "https://replacement.example");
		h.events.windowRemoved.emit(old.windowId);
		expect(fresh.windowId).not.toBe(old.windowId);
		expect(fresh.windowId).not.toBe(10);
		expect(await h.workspace.hello("install", "Chrome/150")).toMatchObject({
			workspaceWindowId: fresh.windowId,
			tabs: [{ tabId: fresh.tabId, url: "https://replacement.example" }],
		});
	});

	test("queued fresh-page creation survives retirement while old captures are cancelled", async () => {
		const h = harness(),
			old = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: old.tabId });
		const blocked = blockCommand(h.api, "Page.captureScreenshot");
		const capture = h.workspace.runRpc({ op: "send", tabId: old.tabId, method: "Page.captureScreenshot" }).then(
			() => false,
			() => true,
		);
		await blocked.entered;
		const created = create(h.workspace, "https://queued.example").then(
			tab => ({ tab }),
			(error: unknown) => ({ error }),
		);
		await settle();
		h.windows.delete(old.windowId);
		h.events.windowRemoved.emit(old.windowId);
		expect(await capture).toBe(true);
		const outcome = await created;
		blocked.finish();
		if ("error" in outcome) throw outcome.error;
		expect(outcome.tab.windowId).not.toBe(old.windowId);
		expect(outcome.tab.url).toBe("https://queued.example");
		expect(h.tabs.get(1)?.active).toBe(true);
	});

	test("window loss cancels awaited Runtime without poisoning a replacement", async () => {
		const h = harness(),
			a = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		const blocked = blockCommand(h.api, "Runtime.evaluate"),
			pending = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Runtime.evaluate" }).then(
				() => false,
				() => true,
			);
		await blocked.entered;
		h.windows.delete(a.windowId);
		h.events.windowRemoved.emit(a.windowId);
		expect(await pending).toBe(true);
		const b = await create(h.workspace);
		expect(b.windowId).not.toBe(a.windowId);
		blocked.finish();
		await settle();
		expect(h.windows.get(10)?.focused).toBe(true);
	});

	test("worker reconstruction restores only its recorded window and releases persisted attachments", async () => {
		const h = harness(),
			a = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		h.focus(a.windowId);
		h.session.workspaceAttachedTabIds = [a.tabId, 1];
		h.attached.add(1);
		h.emulated.set(1, true);
		const restored = new Workspace(h.api, () => {}),
			hello = await restored.hello("install", "Chrome/150");
		if (hello.t !== "hello") throw new Error("Expected hello");
		expect(hello.tabs.map(tab => tab.tabId)).toEqual([a.tabId]);
		expect(hello.attachedTabIds).toEqual([]);
		expect(h.attached.has(1)).toBe(false);
		expect(h.attached.has(a.tabId)).toBe(false);
		await restored.runRpc({ op: "attach", tabId: a.tabId });
		expect(h.attached.has(a.tabId)).toBe(true);
	});

	test("browser-run identity survives worker reconstruction but not a new browser session", async () => {
		const h = harness(),
			first = await h.workspace.hello("install", "Chrome/150");
		const restored = await new Workspace(h.api, () => {}).hello("install", "Chrome/150"),
			fresh = await harness().workspace.hello("install", "Chrome/150");
		if (first.t !== "hello" || restored.t !== "hello" || fresh.t !== "hello") throw new Error("Expected hello");
		expect(restored.browserSession).toBe(first.browserSession);
		expect(fresh.browserSession).not.toBe(first.browserSession);
	});

	test("missing restored windows never cause adoption of a current user window", async () => {
		const h = harness({ workspaceWindowId: 999 }),
			hello = await h.workspace.hello("install", "Chrome/150");
		expect(hello).toMatchObject({ workspaceWindowId: null, tabs: [] });
		const a = await create(h.workspace);
		expect(a.windowId).not.toBe(10);
		expect(h.attached.has(1)).toBe(false);
	});
});
