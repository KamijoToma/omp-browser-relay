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
		attached: new Event<[number, { newWindowId: number; newPosition: number }]>(),
		activated: new Event<[{ tabId: number; windowId: number }]>(),
		focus: new Event<[number]>(),
		windowRemoved: new Event<[number]>(),
		debuggerEvent: new Event<[ChromeDebuggerSession, string, Record<string, unknown>?]>(),
		debuggerDetach: new Event<[ChromeDebuggerSession, string]>(),
	};
	const commands: Array<{ target: ChromeDebuggerSession; method: string; params?: Record<string, unknown> }> = [];
	const emulated = new Map<number, boolean>();
	const dispatches: Array<{ tabId: number; method: string; active: boolean; emulated: boolean; focused: boolean }> =
		[];
	const attached = new Set<number>();
	const messages: ExtToRelayMessage[] = [];
	const creations: Array<{ url: string; focused: boolean; type: "normal" }> = [];
	const removals: number[] = [];
	const selections: number[] = [];
	let nextTab = 2;
	let nextWindow = 20;
	let createGate: Promise<void> | null = null;
	let attachGate: Promise<void> | null = null;
	const api: ChromeApi = {
		tabs: {
			async query(query) {
				return [...tabs.values()].filter(tab => query.windowId === undefined || tab.windowId === query.windowId);
			},
			async get(id) {
				const tab = tabs.get(id);
				if (!tab) throw new Error("No tab");
				return { ...tab };
			},
			async create(properties) {
				if (properties.windowId === undefined || !windows.has(properties.windowId))
					throw new Error("Explicit existing window required");
				const tab = {
					id: nextTab++,
					windowId: properties.windowId,
					active: properties.active ?? true,
					discarded: false,
					url: properties.url,
				};
				if (tab.active)
					for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
				tabs.set(tab.id, tab);
				events.created.emit(tab);
				if (tab.active) events.activated.emit({ tabId: tab.id, windowId: tab.windowId });
				return { ...tab };
			},
			async remove(id) {
				const tab = tabs.get(id);
				if (!tab) throw new Error("No tab");
				removals.push(id);
				tabs.delete(id);
				events.removed.emit(id, { windowId: tab.windowId, isWindowClosing: false });
				if (tab.active) {
					const next = [...tabs.values()].find(other => other.windowId === tab.windowId);
					if (next) {
						next.active = true;
						events.activated.emit({ tabId: next.id!, windowId: next.windowId });
					}
				}
			},
			async update(id, properties) {
				const tab = tabs.get(id);
				if (!tab) throw new Error("No tab");
				if (properties.active && emulated.get(id))
					throw new Error("Native selection would activate an emulated widget");
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
			onCreated: events.created,
			onUpdated: events.updated,
			onRemoved: events.removed,
			onDetached: events.detached,
			onAttached: events.attached,
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
					if (method === "Emulation.setFocusEmulationEnabled") {
						if (params?.enabled === true && tab.active)
							throw new Error("An active native widget cannot emulate focus");
						emulated.set(target.tabId, params?.enabled === true);
					} else {
						dispatches.push({
							tabId: target.tabId,
							method,
							active: tab.active,
							emulated: emulated.get(target.tabId) ?? false,
							focused: windows.get(tab.windowId)?.focused ?? false,
						});
					}
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
		commands,
		attached,
		emulated,
		dispatches,
		messages,
		creations,
		removals,
		selections,
		session,
		events,
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
			events.attached.emit(id, { newWindowId: windowId, newPosition: 0 });
		},
	};
}

async function create(workspace: Workspace, url = "about:blank"): Promise<TabSnapshot> {
	return ((await workspace.runRpc({ op: "createTab", url })) as { tab: TabSnapshot }).tab;
}

async function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

describe("dedicated extension workspace", () => {
	test("ordinary tabs are neither enumerated nor attachable", async () => {
		const h = harness();
		expect(await h.workspace.hello("install-a", "Chrome/150.0")).toMatchObject({
			protocolVersion: 2,
			workspaceWindowId: null,
			tabs: [],
			attachedTabIds: [],
		});
		await expect(h.workspace.runRpc({ op: "attach", tabId: 1 })).rejects.toThrow("not in the dedicated");
		h.events.updated.emit(1, {}, h.tabs.get(1)!);
		expect(h.messages.filter(message => message.t === "tabUpdated")).toEqual([]);
		expect(h.attached.size).toBe(0);
	});

	test("concurrent first creates share one unfocused window, not one tab", async () => {
		const h = harness();
		const gate = Promise.withResolvers<void>();
		h.setCreateGate(gate.promise);
		const first = create(h.workspace, "https://one.example");
		const second = create(h.workspace, "https://two.example");
		await settle();
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(h.creations).toEqual([{ url: h.api.runtime.getURL("workspace.html"), focused: false, type: "normal" }]);
		expect(a.windowId).toBe(20);
		expect(b.windowId).toBe(20);
		expect(a.tabId).not.toBe(b.tabId);
		expect(h.windows.get(10)?.focused).toBe(true);
		expect(h.tabs.get(1)?.active).toBe(true);
		expect(h.session.workspaceWindowId).toBe(20);
		expect(a.active).toBe(false);
		expect(b.active).toBe(false);
		const guardId = h.session.workspaceGuardTabId as number;
		expect(h.tabs.get(guardId)).toMatchObject({
			windowId: 20,
			active: true,
			url: h.api.runtime.getURL("workspace.html"),
		});
		const hello = await h.workspace.hello("install", "Chrome/150");
		expect(hello).toMatchObject({ tabs: [{ tabId: a.tabId }, { tabId: b.tabId }] });
		expect(
			h.messages.some(
				message => (message.t === "tabCreated" || message.t === "tabUpdated") && message.tab.tabId === guardId,
			),
		).toBe(false);
		for (const op of ["attach", "detach", "activateTab", "removeTab"] as const) {
			await expect(h.workspace.runRpc({ op, tabId: guardId })).rejects.toThrow("reserved");
		}
		expect(h.tabs.has(guardId)).toBe(true);
		expect(h.attached.has(guardId)).toBe(false);
	});

	test("selection, screenshots, and OOPIF input never focus a window", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		await h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Page.bringToFront" });
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Target.activateTarget",
			params: { targetId: `real-${tab.tabId}` },
		});
		await h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Page.captureScreenshot" });
		h.events.debuggerEvent.emit({ tabId: tab.tabId }, "Target.attachedToTarget", {
			sessionId: "oopif",
			targetInfo: { targetId: "child", type: "iframe" },
		});
		await settle();
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			sessionId: "oopif",
			method: "Input.dispatchMouseEvent",
			params: { type: "mouseMoved", x: 20, y: 30 },
		});
		expect(h.commands.some(command => command.target.sessionId === "oopif")).toBe(true);
		expect(
			h.commands.some(
				command => command.method === "Page.bringToFront" || command.method === "Target.activateTarget",
			),
		).toBe(false);
		expect(h.dispatches.find(dispatch => dispatch.method === "Page.captureScreenshot")).toMatchObject({
			active: true,
			emulated: false,
			focused: false,
		});
		expect(h.dispatches.find(dispatch => dispatch.method === "Input.dispatchMouseEvent")).toMatchObject({
			active: false,
			emulated: true,
			focused: false,
		});
		expect(h.tabs.get(h.session.workspaceGuardTabId as number)?.active).toBe(true);
		expect(h.tabs.get(tab.tabId)?.active).toBe(false);
		expect(h.windows.get(10)?.focused).toBe(true);
	});

	test("global/native commands, forged targets/sessions, and invalid focus requests fail", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		for (const method of [
			"Browser.close",
			"Browser.setWindowBounds",
			"SystemInfo.getInfo",
			"DeviceAccess.selectPrompt",
			"Target.sendMessageToTarget",
			"Target.setDiscoverTargets",
		]) {
			await expect(h.workspace.runRpc({ op: "send", tabId: tab.tabId, method })).rejects.toThrow();
		}
		for (const enabled of [undefined, null, 0, 1, "true", {}, []]) {
			await expect(
				h.workspace.runRpc({
					op: "send",
					tabId: tab.tabId,
					method: "Emulation.setFocusEmulationEnabled",
					params: { enabled },
				}),
			).rejects.toThrow("boolean");
		}
		expect(h.emulated.get(tab.tabId)).toBe(true);
		await expect(
			h.workspace.runRpc({ op: "send", tabId: tab.tabId, sessionId: "forged", method: "Runtime.evaluate" }),
		).rejects.toThrow("Unknown");
		await expect(
			h.workspace.runRpc({
				op: "send",
				tabId: tab.tabId,
				method: "Target.activateTarget",
				params: { targetId: "real-1" },
			}),
		).rejects.toThrow("not owned");
	});

	test("client focus requests survive ordinary commands and temporary screenshot selection", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		const selections = [...h.selections];
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Emulation.setFocusEmulationEnabled",
			params: { enabled: false },
		});
		expect(h.emulated.get(tab.tabId)).toBe(false);
		expect(h.selections).toEqual(selections);
		await h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Runtime.evaluate" });
		expect(h.dispatches.at(-1)).toMatchObject({ method: "Runtime.evaluate", active: false, emulated: false });
		await h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Page.captureScreenshot" });
		expect(h.dispatches.at(-1)).toMatchObject({
			method: "Page.captureScreenshot",
			active: true,
			emulated: false,
			focused: false,
		});
		expect(h.tabs.get(h.session.workspaceGuardTabId as number)?.active).toBe(true);
		expect(h.emulated.get(tab.tabId)).toBe(false);
		await h.workspace.runRpc({ op: "activateTab", tabId: tab.tabId });
		expect(h.tabs.get(tab.tabId)?.active).toBe(true);
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Emulation.setFocusEmulationEnabled",
			params: { enabled: true },
		});
		expect(h.tabs.get(tab.tabId)?.active).toBe(false);
		expect(h.tabs.get(h.session.workspaceGuardTabId as number)?.active).toBe(true);
		expect(h.emulated.get(tab.tabId)).toBe(true);
		expect(h.windows.get(10)?.focused).toBe(true);
	});

	test("focus disable is available while paused and resume preserves it until enabled or detached", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		h.focus(tab.windowId);
		await settle();
		const selections = [...h.selections];
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Emulation.setFocusEmulationEnabled",
			params: { enabled: false },
		});
		await expect(
			h.workspace.runRpc({
				op: "send",
				tabId: tab.tabId,
				method: "Emulation.setFocusEmulationEnabled",
				params: { enabled: true },
			}),
		).rejects.toThrow("paused");
		expect(h.selections).toEqual(selections);
		h.focus(10);
		await settle();
		expect(h.emulated.get(tab.tabId)).toBe(false);
		await h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Input.dispatchKeyEvent" });
		expect(h.dispatches.at(-1)).toMatchObject({ active: false, emulated: false, focused: false });
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Emulation.setFocusEmulationEnabled",
			params: { enabled: true },
		});
		expect(h.emulated.get(tab.tabId)).toBe(true);
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Emulation.setFocusEmulationEnabled",
			params: { enabled: false },
		});
		await h.workspace.runRpc({ op: "detach", tabId: tab.tabId });
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		expect(h.emulated.get(tab.tabId)).toBe(true);
	});

	test("focus disable bypasses blocked Runtime and screenshots without selecting a native view", async () => {
		for (const blockedMethod of ["Runtime.evaluate", "Page.captureScreenshot"]) {
			const h = harness();
			const tab = await create(h.workspace);
			await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
			const gate = Promise.withResolvers<void>();
			const send = h.api.debugger.sendCommand;
			h.api.debugger.sendCommand = async (target, method, params) => {
				const result = await send(target, method, params);
				if (method === blockedMethod) await gate.promise;
				return result;
			};
			const blocked = h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: blockedMethod });
			await settle();
			const selections = [...h.selections];
			await h.workspace.runRpc({
				op: "send",
				tabId: tab.tabId,
				method: "Emulation.setFocusEmulationEnabled",
				params: { enabled: false },
			});
			expect(h.emulated.get(tab.tabId)).toBe(false);
			expect(h.selections).toEqual(selections);
			expect(h.tabs.get(tab.tabId)?.active).toBe(blockedMethod === "Page.captureScreenshot");
			gate.resolve();
			await blocked;
			await h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Runtime.getIsolateId" });
			expect(h.dispatches.at(-1)).toMatchObject({ active: false, emulated: false, focused: false });
			expect(h.tabs.get(h.session.workspaceGuardTabId as number)?.active).toBe(true);
			expect(h.windows.get(10)?.focused).toBe(true);
		}
	});

	test("discarded snapshots report Chrome state and selection publishes native revival without attachment", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		h.tabs.get(tab.tabId)!.discarded = true;
		h.events.updated.emit(tab.tabId, { discarded: true }, h.tabs.get(tab.tabId)!);
		expect(h.messages.at(-1)).toMatchObject({ t: "tabUpdated", tab: { tabId: tab.tabId, discarded: true } });
		expect(await h.workspace.hello("install", "Chrome/150")).toMatchObject({
			tabs: [{ tabId: tab.tabId, discarded: true }],
		});
		await h.workspace.runRpc({ op: "activateTab", tabId: tab.tabId });
		await settle();
		expect(h.tabs.get(tab.tabId)).toMatchObject({ active: true, discarded: false });
		expect(h.messages).toContainEqual({
			t: "tabUpdated",
			tab: { ...tab, active: true, discarded: false },
		});
		expect(await h.workspace.hello("install", "Chrome/150")).toMatchObject({
			tabs: [{ tabId: tab.tabId, active: true, discarded: false }],
		});
		expect(h.attached.size).toBe(0);
		expect(h.commands).toEqual([]);
		expect(h.windows.get(10)?.focused).toBe(true);
	});

	test("browser session identity survives worker reconstruction but not a new browser session", async () => {
		const h = harness();
		const first = await h.workspace.hello("same-install", "Chrome/150");
		if (first.t !== "hello") throw new Error("Expected hello");
		expect(first.browserSession).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
		const reconstructed = new Workspace(h.api, () => {});
		const restored = await reconstructed.hello("same-install", "Chrome/150");
		if (restored.t !== "hello") throw new Error("Expected hello");
		expect(restored.browserSession).toBe(first.browserSession);
		const restarted = await harness().workspace.hello("same-install", "Chrome/150");
		if (restarted.t !== "hello") throw new Error("Expected hello");
		expect(restarted.browserSession).not.toBe(first.browserSession);
	});

	test("focusing workspace pauses control and emulation; leaving resumes without focus restoration", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		h.focus(tab.windowId);
		await settle();
		for (const request of [
			{ op: "send", tabId: tab.tabId, method: "Runtime.evaluate" } as const,
			{ op: "activateTab", tabId: tab.tabId } as const,
			{ op: "removeTab", tabId: tab.tabId } as const,
			{ op: "attach", tabId: tab.tabId } as const,
			{ op: "createTab", url: "about:blank" } as const,
		])
			await expect(h.workspace.runRpc(request)).rejects.toThrow("paused");
		expect(h.commands.at(-1)).toMatchObject({
			method: "Emulation.setFocusEmulationEnabled",
			params: { enabled: false },
		});
		h.focus(10);
		await settle();
		await h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Runtime.evaluate" });
		expect(
			h.commands
				.filter(command => command.method === "Emulation.setFocusEmulationEnabled")
				.map(command => command.params?.enabled),
		).toEqual([true, false, true]);
		expect(h.messages).toContainEqual({ t: "workspace", windowId: tab.windowId, paused: true });
		expect(h.windows.get(10)?.focused).toBe(true);
	});

	test("resumed input waits until focus emulation has actually been restored", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		h.focus(tab.windowId);
		await settle();
		const gate = Promise.withResolvers<void>();
		const send = h.api.debugger.sendCommand;
		h.api.debugger.sendCommand = async (target, method, params) => {
			if (method === "Emulation.setFocusEmulationEnabled" && params?.enabled === true) await gate.promise;
			return send(target, method, params);
		};
		h.focus(10);
		const input = h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Input.dispatchKeyEvent",
			params: { type: "keyDown" },
		});
		await settle();
		expect(h.commands.some(command => command.method === "Input.dispatchKeyEvent")).toBe(false);
		gate.resolve();
		await input;
		expect(h.commands.at(-1)?.method).toBe("Input.dispatchKeyEvent");
	});

	test("rechecks ownership after asynchronous focus queries, before attaching or sending", async () => {
		for (const operation of ["attach", "send"] as const) {
			const h = harness();
			const tab = await create(h.workspace);
			if (operation === "send") await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
			let queries = 0;
			h.api.windows.get = async id => {
				if (++queries === 2) h.tabs.get(tab.tabId)!.windowId = 10;
				const window = h.windows.get(id);
				if (!window) throw new Error("No window");
				return { ...window };
			};
			const count = h.commands.length;
			await expect(
				h.workspace.runRpc(
					operation === "attach"
						? { op: "attach", tabId: tab.tabId }
						: {
								op: "send",
								tabId: tab.tabId,
								method: "Input.dispatchKeyEvent",
								params: { type: "keyDown", key: "a" },
							},
				),
			).rejects.toThrow("not in the dedicated");
			await settle();
			expect(h.commands.slice(count).some(command => command.method === "Input.dispatchKeyEvent")).toBe(false);
			expect(h.attached.has(tab.tabId)).toBe(false);
		}
	});

	test("page dialogs support acceptance; only explicit dismissal bypasses pause and never ownership", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Page.handleJavaScriptDialog",
			params: { accept: true },
		});
		expect(h.commands.at(-1)).toMatchObject({ method: "Page.handleJavaScriptDialog", params: { accept: true } });
		h.focus(tab.windowId);
		await settle();
		await expect(
			h.workspace.runRpc({
				op: "send",
				tabId: tab.tabId,
				method: "Page.handleJavaScriptDialog",
				params: { accept: true },
			}),
		).rejects.toThrow("paused");
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Page.handleJavaScriptDialog",
			params: { accept: false },
		});
		expect(h.commands.at(-1)).toMatchObject({ method: "Page.handleJavaScriptDialog", params: { accept: false } });
		h.move(tab.tabId, 10);
		await settle();
		await expect(
			h.workspace.runRpc({
				op: "send",
				tabId: tab.tabId,
				method: "Page.handleJavaScriptDialog",
				params: { accept: false },
			}),
		).rejects.toThrow("not in the dedicated");
	});

	test("detach and disconnect release emulation while paused", async () => {
		const h = harness();
		const a = await create(h.workspace);
		const b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		await h.workspace.runRpc({ op: "attach", tabId: b.tabId });
		h.focus(a.windowId);
		await settle();
		await h.workspace.runRpc({ op: "detach", tabId: a.tabId });
		await h.workspace.releaseAll();
		expect(h.attached.size).toBe(0);
		expect(h.session.workspaceAttachedTabIds).toEqual([]);
		for (const tabId of [a.tabId, b.tabId])
			expect(h.commands.filter(command => command.target.tabId === tabId).at(-1)?.params).toEqual({
				enabled: false,
			});
	});

	test("moving out retracts/detaches and denies send/remove, even if migration events were missed", async () => {
		const h = harness();
		const a = await create(h.workspace);
		const b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		h.move(a.tabId, 10);
		await settle();
		expect(h.messages).toContainEqual({ t: "tabRemoved", tabId: a.tabId });
		expect(h.attached.has(a.tabId)).toBe(false);
		h.tabs.get(b.tabId)!.windowId = 10;
		for (const tabId of [a.tabId, b.tabId]) {
			await expect(h.workspace.runRpc({ op: "send", tabId, method: "Runtime.evaluate" })).rejects.toThrow(
				"not in the dedicated",
			);
			await expect(h.workspace.runRpc({ op: "removeTab", tabId })).rejects.toThrow("not in the dedicated");
		}
		expect(h.removals).toEqual([]);
	});

	test("window closure clears ownership and next create makes a new window", async () => {
		const h = harness();
		const a = await create(h.workspace);
		h.windows.delete(a.windowId);
		h.tabs.delete(a.tabId);
		h.events.windowRemoved.emit(a.windowId);
		await settle();
		expect(await h.workspace.hello("same-install", "Chrome/150")).toMatchObject({
			workspaceWindowId: null,
			tabs: [],
		});
		expect((await create(h.workspace)).windowId).toBe(21);
		expect(h.creations.length).toBe(2);
	});

	test("restart restores only the recorded window and releases persisted debugger state", async () => {
		const h = harness();
		const a = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		const restored = new Workspace(h.api, () => {});
		expect(await restored.hello("same-install", "Chrome/150")).toMatchObject({
			workspaceWindowId: a.windowId,
			tabs: [{ tabId: a.tabId }],
			attachedTabIds: [],
		});
		expect(h.attached.size).toBe(0);
		const missing = harness({ workspaceWindowId: 999 });
		expect(await missing.workspace.hello("same-install", "Chrome/150")).toMatchObject({
			workspaceWindowId: null,
			tabs: [],
		});
		expect((await create(missing.workspace)).windowId).toBe(20);
	});

	test("disconnect during attach cannot leak emulation or an attachment", async () => {
		const h = harness();
		const a = await create(h.workspace);
		const gate = Promise.withResolvers<void>();
		h.setAttachGate(gate.promise);
		const attaching = h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		await settle();
		const releasing = h.workspace.releaseAll();
		gate.resolve();
		await expect(attaching).rejects.toThrow("disconnected");
		await releasing;
		expect(h.attached.size).toBe(0);
		expect(h.commands.at(-1)?.params).toEqual({ enabled: false });
	});

	test("active work tabs lose emulation before native selection and return behind the guard for Runtime and input", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		await h.workspace.runRpc({ op: "activateTab", tabId: tab.tabId });
		expect(h.tabs.get(tab.tabId)?.active).toBe(true);
		expect(h.emulated.get(tab.tabId)).toBe(false);
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Runtime.callFunctionOn",
			params: {
				functionDeclaration:
					"() => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(resolve); return promise; }",
			},
		});
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Input.dispatchKeyEvent",
			params: { type: "keyDown", key: "a" },
		});
		await h.workspace.runRpc({
			op: "send",
			tabId: tab.tabId,
			method: "Input.dispatchKeyEvent",
			params: { type: "keyUp", key: "a" },
		});
		expect(
			h.dispatches.filter(
				dispatch => dispatch.method === "Runtime.callFunctionOn" || dispatch.method === "Input.dispatchKeyEvent",
			),
		).toEqual([
			{ tabId: tab.tabId, method: "Runtime.callFunctionOn", active: false, emulated: true, focused: false },
			{ tabId: tab.tabId, method: "Input.dispatchKeyEvent", active: false, emulated: true, focused: false },
			{ tabId: tab.tabId, method: "Input.dispatchKeyEvent", active: false, emulated: true, focused: false },
		]);
		expect(
			h.commands
				.filter(command => command.method === "Emulation.setFocusEmulationEnabled")
				.map(command => command.params?.enabled),
		).toEqual([true, false, true]);
		expect(h.tabs.get(h.session.workspaceGuardTabId as number)?.active).toBe(true);
	});

	test("closing, moving, or navigating the reserved guard never repurposes or closes a user page", async () => {
		for (const damage of ["closed", "moved", "navigated"] as const) {
			const h = harness();
			const tab = await create(h.workspace);
			await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
			const oldGuard = h.session.workspaceGuardTabId as number;
			if (damage === "closed") await h.api.tabs.remove(oldGuard);
			else if (damage === "moved") h.move(oldGuard, 10);
			else {
				h.tabs.get(oldGuard)!.url = "https://user-edited.example";
				h.events.updated.emit(oldGuard, { url: "https://user-edited.example" }, h.tabs.get(oldGuard)!);
			}
			await settle();
			await h.workspace.runRpc({
				op: "send",
				tabId: tab.tabId,
				method: "Input.dispatchMouseEvent",
				params: { type: "mousePressed", x: 5, y: 8, button: "left", clickCount: 1 },
			});
			const guard = h.session.workspaceGuardTabId as number;
			expect(guard).not.toBe(oldGuard);
			expect(h.tabs.get(guard)).toMatchObject({
				active: true,
				windowId: tab.windowId,
				url: h.api.runtime.getURL("workspace.html"),
			});
			expect(h.dispatches.at(-1)).toMatchObject({
				method: "Input.dispatchMouseEvent",
				active: false,
				emulated: true,
			});
			expect(h.attached.has(guard)).toBe(false);
			expect(h.removals).toEqual(damage === "closed" ? [oldGuard] : []);
			if (damage === "moved") expect(h.tabs.get(oldGuard)?.windowId).toBe(10);
			if (damage === "navigated") {
				expect(h.tabs.get(oldGuard)?.url).toBe("https://user-edited.example");
				expect(await h.workspace.hello("install", "Chrome/150")).toMatchObject({
					tabs: [{ tabId: oldGuard }, { tabId: tab.tabId }],
				});
				await h.workspace.runRpc({ op: "attach", tabId: oldGuard });
				expect(h.attached.has(oldGuard)).toBe(true);
			}
			expect(
				h.messages.some(
					message => (message.t === "tabCreated" || message.t === "tabUpdated") && message.tab.tabId === guard,
				),
			).toBe(false);
		}
	});

	test("restart validates the recorded guard ID, window, and current or pending URL rather than rediscovering by URL", async () => {
		for (const damage of ["missing", "moved", "navigated", "pending-navigation"] as const) {
			const h = harness();
			const tab = await create(h.workspace);
			const guard = h.session.workspaceGuardTabId as number;
			const sameUrlWork = await create(h.workspace, h.api.runtime.getURL("workspace.html"));
			if (damage === "missing") h.tabs.delete(guard);
			else if (damage === "moved") h.tabs.get(guard)!.windowId = 10;
			else if (damage === "navigated") h.tabs.get(guard)!.url = "https://user-edited.example";
			else h.tabs.get(guard)!.pendingUrl = "https://user-edited.example";
			const restored = new Workspace(h.api, () => {});
			const hello = await restored.hello("install", "Chrome/150");
			expect(h.session.workspaceGuardTabId).toBeNull();
			expect(hello).toMatchObject({ workspaceWindowId: tab.windowId });
			if (hello.t !== "hello") throw new Error("Expected hello");
			expect(hello.tabs.some(item => item.tabId === sameUrlWork.tabId)).toBe(true);
			expect(hello.tabs.some(item => item.tabId === guard)).toBe(
				damage === "navigated" || damage === "pending-navigation",
			);
		}
	});

	test("captures serialize native views across connections while cleanup and intercepted requests can release a blocked capture", async () => {
		const h = harness();
		const a = await create(h.workspace);
		const b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		await h.workspace.runRpc({ op: "attach", tabId: b.tabId });
		await h.workspace.runRpc({
			op: "send",
			tabId: a.tabId,
			method: "Fetch.enable",
			params: { patterns: [{ urlPattern: "*" }] },
		});
		h.events.debuggerEvent.emit({ tabId: a.tabId }, "Target.attachedToTarget", {
			sessionId: "child",
			targetInfo: { targetId: "iframe" },
		});
		await settle();
		const gate = Promise.withResolvers<void>();
		const send = h.api.debugger.sendCommand;
		h.api.debugger.sendCommand = async (target, method, params) => {
			const result = await send(target, method, params);
			if (method === "Page.captureScreenshot") await gate.promise;
			return result;
		};
		const capture = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Page.captureScreenshot" });
		await settle();
		const input = h.workspace.runRpc({
			op: "send",
			tabId: b.tabId,
			method: "Input.dispatchMouseEvent",
			params: { type: "mouseMoved", x: 12, y: 18 },
		});
		await settle();
		expect(h.tabs.get(a.tabId)?.active).toBe(true);
		expect(h.emulated.get(a.tabId)).toBe(false);
		expect(h.dispatches.some(dispatch => dispatch.method === "Input.dispatchMouseEvent")).toBe(false);
		for (const method of [
			"Page.screencastFrameAck",
			"Runtime.runIfWaitingForDebugger",
			"Page.stopScreencast",
			"Fetch.continueRequest",
		]) {
			await h.workspace.runRpc({
				op: "send",
				tabId: a.tabId,
				method,
				params: { sessionId: 1, requestId: "request" },
			});
		}
		await h.workspace.runRpc({
			op: "send",
			tabId: a.tabId,
			method: "Target.detachFromTarget",
			params: { sessionId: "child" },
		});
		await h.workspace.runRpc({
			op: "send",
			tabId: a.tabId,
			method: "Page.handleJavaScriptDialog",
			params: { accept: false },
		});
		await h.workspace.runRpc({
			op: "send",
			tabId: a.tabId,
			method: "Page.handleJavaScriptDialog",
			params: { accept: true },
		});
		expect(h.tabs.get(a.tabId)?.active).toBe(true);
		gate.resolve();
		await capture;
		await input;
		expect(h.dispatches.find(dispatch => dispatch.method === "Page.captureScreenshot")).toMatchObject({
			tabId: a.tabId,
			active: true,
			emulated: false,
		});
		expect(h.dispatches.find(dispatch => dispatch.method === "Input.dispatchMouseEvent")).toMatchObject({
			tabId: b.tabId,
			active: false,
			emulated: true,
		});
		expect(h.tabs.get(h.session.workspaceGuardTabId as number)?.active).toBe(true);
		expect(h.windows.get(10)?.focused).toBe(true);
	});

	// Buffer rejections before cancelling; Bun's eager promise matchers can block the cancellation trigger.
	test("detach and disconnect unblock a hanging capture, without late view restoration or stale queued dispatch", async () => {
		for (const release of ["detach", "disconnect"] as const) {
			const h = harness();
			const a = await create(h.workspace);
			const b = await create(h.workspace);
			await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
			await h.workspace.runRpc({ op: "attach", tabId: b.tabId });
			const gate = Promise.withResolvers<void>();
			const send = h.api.debugger.sendCommand;
			h.api.debugger.sendCommand = async (target, method, params) => {
				const result = await send(target, method, params);
				if (method === "Page.captureScreenshot") await gate.promise;
				return result;
			};
			const capture = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Page.captureScreenshot" });
			await settle();
			const captureRejected = capture.catch((error: unknown) => error);
			const input = h.workspace.runRpc({
				op: "send",
				tabId: b.tabId,
				method: "Input.dispatchKeyEvent",
				params: { type: "keyDown", key: "b" },
			});
			if (release === "disconnect") {
				const staleRejected = input.catch((error: unknown) => error);
				await h.workspace.releaseAll();
				expect(await staleRejected).toMatchObject({ message: expect.stringContaining("disconnected") });
				expect(h.dispatches.some(dispatch => dispatch.method === "Input.dispatchKeyEvent")).toBe(false);
				await h.workspace.runRpc({ op: "attach", tabId: b.tabId });
				await h.workspace.runRpc({
					op: "send",
					tabId: b.tabId,
					method: "Input.dispatchKeyEvent",
					params: { type: "keyDown", key: "c" },
				});
			} else {
				await h.workspace.runRpc({ op: "detach", tabId: a.tabId });
				await input;
			}
			expect(await captureRejected).toBeInstanceOf(Error);
			expect(h.attached.has(a.tabId)).toBe(false);
			expect(h.dispatches.at(-1)).toMatchObject({
				tabId: b.tabId,
				method: "Input.dispatchKeyEvent",
				active: false,
				emulated: true,
			});
			const selections = [...h.selections];
			gate.resolve();
			await settle();
			expect(h.selections).toEqual(selections);
			expect(h.tabs.get(h.session.workspaceGuardTabId as number)?.active).toBe(true);
		}
	});

	test("user takeover cancels queued control and late capture completion cannot undo the user's native selection", async () => {
		const h = harness();
		const a = await create(h.workspace);
		const b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		await h.workspace.runRpc({ op: "attach", tabId: b.tabId });
		const gate = Promise.withResolvers<void>();
		const send = h.api.debugger.sendCommand;
		h.api.debugger.sendCommand = async (target, method, params) => {
			const result = await send(target, method, params);
			if (method === "Page.captureScreenshot") await gate.promise;
			return result;
		};
		const capture = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Page.captureScreenshot" });
		await settle();
		const captureRejected = capture.catch((error: unknown) => error);
		const input = h.workspace.runRpc({
			op: "send",
			tabId: b.tabId,
			method: "Input.dispatchKeyEvent",
			params: { type: "keyDown" },
		});
		const inputRejected = input.catch((error: unknown) => error);
		h.focus(a.windowId);
		expect(await captureRejected).toMatchObject({ message: expect.stringContaining("paused") });
		expect(await inputRejected).toMatchObject({ message: expect.stringContaining("paused") });
		await settle();
		await h.api.tabs.update(b.tabId, { active: true });
		await settle();
		expect(h.emulated.get(a.tabId)).toBe(false);
		expect(h.emulated.get(b.tabId)).toBe(false);
		await h.workspace.runRpc({
			op: "send",
			tabId: a.tabId,
			method: "Page.handleJavaScriptDialog",
			params: { accept: false },
		});
		const selections = [...h.selections];
		gate.resolve();
		await settle();
		expect(h.selections).toEqual(selections);
		h.focus(10);
		await settle();
		expect(h.tabs.get(b.tabId)?.active).toBe(true);
		expect(h.emulated.get(b.tabId)).toBe(false);
		expect(h.dispatches.some(dispatch => dispatch.method === "Input.dispatchKeyEvent")).toBe(false);
		await h.workspace.runRpc({
			op: "send",
			tabId: b.tabId,
			method: "Input.dispatchKeyEvent",
			params: { type: "keyDown" },
		});
		expect(h.dispatches.at(-1)).toMatchObject({ tabId: b.tabId, active: false, emulated: true });
	});

	test("migration while capture is pending releases ownership and never restores the moved user's tab", async () => {
		const h = harness();
		const tab = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
		const gate = Promise.withResolvers<void>();
		const send = h.api.debugger.sendCommand;
		h.api.debugger.sendCommand = async (target, method, params) => {
			const result = await send(target, method, params);
			if (method === "Page.captureScreenshot") await gate.promise;
			return result;
		};
		const capture = h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Page.captureScreenshot" });
		await settle();
		const rejected = capture.catch((error: unknown) => error);
		h.move(tab.tabId, 10);
		expect(await rejected).toMatchObject({ message: expect.stringContaining("not in the dedicated") });
		await settle();
		expect(h.attached.has(tab.tabId)).toBe(false);
		const selections = [...h.selections];
		gate.resolve();
		await settle();
		expect(h.selections).toEqual(selections);
		expect(h.tabs.get(tab.tabId)?.windowId).toBe(10);
		await expect(
			h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Page.screencastFrameAck" }),
		).rejects.toThrow("not in the dedicated");
	});

	test("cancelling a native selection does not unlock the next input until that selection has settled", async () => {
		const h = harness();
		const a = await create(h.workspace);
		const b = await create(h.workspace);
		await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
		await h.workspace.runRpc({ op: "attach", tabId: b.tabId });
		const gate = Promise.withResolvers<void>();
		const update = h.api.tabs.update;
		h.api.tabs.update = async (id, properties) => {
			if (id === a.tabId && properties.active) await gate.promise;
			return update(id, properties);
		};
		const capture = h.workspace.runRpc({ op: "send", tabId: a.tabId, method: "Page.captureScreenshot" });
		await settle();
		const rejected = capture.catch((error: unknown) => error);
		await h.workspace.runRpc({ op: "detach", tabId: a.tabId });
		const input = h.workspace.runRpc({
			op: "send",
			tabId: b.tabId,
			method: "Input.dispatchKeyEvent",
			params: { type: "keyDown" },
		});
		await settle();
		expect(
			h.dispatches.some(
				dispatch => dispatch.method === "Input.dispatchKeyEvent" || dispatch.method === "Page.captureScreenshot",
			),
		).toBe(false);
		gate.resolve();
		expect(await rejected).toBeInstanceOf(Error);
		await input;
		expect(h.dispatches.at(-1)).toMatchObject({
			tabId: b.tabId,
			method: "Input.dispatchKeyEvent",
			active: false,
			emulated: true,
		});
		expect(h.tabs.get(h.session.workspaceGuardTabId as number)?.active).toBe(true);
	});

	test("disconnect during first window creation shares its pending guard and never creates the old requested page", async () => {
		const h = harness();
		const gate = Promise.withResolvers<void>();
		h.setCreateGate(gate.promise);
		const stale = create(h.workspace, "https://stale.example");
		await settle();
		const rejected = stale.catch((error: unknown) => error);
		await h.workspace.releaseAll();
		const fresh = create(h.workspace, "https://fresh.example");
		gate.resolve();
		expect(await rejected).toMatchObject({ message: expect.stringContaining("disconnected") });
		const tab = await fresh;
		expect(h.creations).toEqual([{ url: h.api.runtime.getURL("workspace.html"), focused: false, type: "normal" }]);
		expect([...h.tabs.values()].some(item => item.url === "https://stale.example")).toBe(false);
		expect(tab).toMatchObject({ url: "https://fresh.example", active: false, windowId: 20 });
		expect(await h.workspace.hello("install", "Chrome/150")).toMatchObject({ tabs: [{ tabId: tab.tabId }] });
	});

	test("viewport failures and screencast startup restore the inactive interaction view without substituting capture commands", async () => {
		for (const method of ["Page.captureScreenshot", "Page.startScreencast"]) {
			const h = harness();
			const tab = await create(h.workspace);
			await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
			const send = h.api.debugger.sendCommand;
			h.api.debugger.sendCommand = async (target, command, params) => {
				const result = await send(target, command, params);
				if (command === method) throw new Error("Viewport command failed");
				return result;
			};
			await expect(h.workspace.runRpc({ op: "send", tabId: tab.tabId, method })).rejects.toThrow(
				"Viewport command failed",
			);
			expect(h.dispatches.find(dispatch => dispatch.method === method)).toMatchObject({
				tabId: tab.tabId,
				active: true,
				emulated: false,
				focused: false,
			});
			expect(h.tabs.get(tab.tabId)?.active).toBe(false);
			expect(h.emulated.get(tab.tabId)).toBe(true);
			expect(h.tabs.get(h.session.workspaceGuardTabId as number)?.active).toBe(true);
			await h.workspace.runRpc({
				op: "send",
				tabId: tab.tabId,
				method: "Input.dispatchMouseEvent",
				params: { type: "mouseMoved", x: 1, y: 2 },
			});
			expect(h.dispatches.at(-1)).toMatchObject({
				method: "Input.dispatchMouseEvent",
				active: false,
				emulated: true,
			});
		}
	});
});

test("discarding during native attach retracts the late attachment without enabling focus", async () => {
	const h = harness();
	const tab = await create(h.workspace);
	const gate = Promise.withResolvers<void>();
	h.setAttachGate(gate.promise);
	const attachment = h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
	const outcome = attachment.then(
		() => "attached",
		error => String(error),
	);
	await settle();
	const native = h.tabs.get(tab.tabId)!;
	native.discarded = true;
	h.events.updated.emit(tab.tabId, { discarded: true }, { ...native });
	gate.resolve();
	expect(await outcome).toMatch(/discarded/i);
	expect(h.attached.has(tab.tabId)).toBeFalse();
	expect(
		h.commands.some(
			command => command.method === "Emulation.setFocusEmulationEnabled" && command.params?.enabled === true,
		),
	).toBeFalse();
});

test("an awaited page promise cannot block closing another tab, and user takeover still cancels it", async () => {
	const h = harness();
	const a = await create(h.workspace);
	const b = await create(h.workspace);
	await h.workspace.runRpc({ op: "attach", tabId: a.tabId });
	const gate = Promise.withResolvers<Record<string, unknown>>();
	const send = h.api.debugger.sendCommand;
	h.api.debugger.sendCommand = (target, method, params) =>
		method === "Runtime.evaluate" ? gate.promise : send(target, method, params);
	const waiting = h.workspace.runRpc({
		op: "send",
		tabId: a.tabId,
		method: "Runtime.evaluate",
		params: { expression: "Promise.withResolvers().promise", awaitPromise: true },
	});
	const observed = waiting.catch((error: unknown) => error);
	await settle();
	await h.workspace.runRpc({ op: "removeTab", tabId: b.tabId });
	expect(h.tabs.has(b.tabId)).toBeFalse();
	h.focus(a.windowId);
	expect(await observed).toMatchObject({ message: expect.stringContaining("paused") });
	gate.resolve({});
	await settle();
});

test("late screencast cleanup from a disconnected relay cannot suppress a new recording's frames", async () => {
	const h = harness();
	const tab = await create(h.workspace);
	await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
	await h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Page.startScreencast" });
	const gate = Promise.withResolvers<void>();
	const send = h.api.debugger.sendCommand;
	let holdStop = true;
	h.api.debugger.sendCommand = async (target, method, params) => {
		const result = await send(target, method, params);
		if (method === "Page.stopScreencast" && holdStop) {
			holdStop = false;
			await gate.promise;
		}
		return result;
	};
	const oldStop = h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Page.stopScreencast" });
	await settle();
	await h.workspace.releaseAll();
	await h.workspace.runRpc({ op: "attach", tabId: tab.tabId });
	await h.workspace.runRpc({ op: "send", tabId: tab.tabId, method: "Page.startScreencast" });
	gate.resolve();
	await oldStop;
	h.events.debuggerEvent.emit({ tabId: tab.tabId }, "Page.screencastFrame", {
		sessionId: 42,
		data: "new-recording-frame",
	});
	await settle();
	expect(
		h.messages.some(
			message =>
				message.t === "cdpEvent" && message.method === "Page.screencastFrame" && message.params?.sessionId === 42,
		),
	).toBeTrue();
});
