import {
	DISCARDED_TABS_PROTOCOL_VERSION,
	isWorkspaceCleanupCommand,
	RELAY_PROTOCOL_VERSION,
	type ExtToRelayMessage,
	type RelayRpcRequest,
	type TabSnapshot,
} from "../src/protocol";

const SESSION_KEY = "workspaceWindowId";
const ATTACHED_KEY = "workspaceAttachedTabIds";
const BROWSER_SESSION_KEY = "relayBrowserSession";
const PAGE_DOMAINS: Record<string, true> = {
	Accessibility: true,
	Animation: true,
	Audits: true,
	CSS: true,
	DOM: true,
	DOMDebugger: true,
	DOMSnapshot: true,
	Debugger: true,
	Emulation: true,
	Fetch: true,
	HeapProfiler: true,
	Input: true,
	Inspector: true,
	LayerTree: true,
	Log: true,
	Media: true,
	Network: true,
	Overlay: true,
	Page: true,
	Performance: true,
	PerformanceTimeline: true,
	Profiler: true,
	Runtime: true,
	Security: true,
	WebAudio: true,
};

interface ViewOperation {
	epoch: number;
	tabId?: number;
	cancelled: boolean;
	reason: string;
	interrupted: Promise<void>;
	cancel(reason?: string): void;
	release(): void;
}

/** Window membership is the authorization boundary; users and agents share its visible pages. */
export class Workspace {
	readonly ready: Promise<void>;
	#api: ChromeApi;
	#emit: (message: ExtToRelayMessage) => void;
	#windowId: number | null = null;
	#browserSession = "";
	#known = new Set<number>();
	#attached = new Set<number>();
	#attaching = new Map<number, Promise<void>>();
	#detaching = new Map<number, Promise<void>>();
	#children = new Map<number, Map<string, string>>();
	#storageOps: Promise<void> = Promise.resolve();
	#joining = new Map<number, number>();
	#joinSequence = 0;
	#viewTail: Promise<void> = Promise.resolve();
	#views = new Set<ViewOperation>();
	#epoch = 0;

	constructor(api: ChromeApi, emit: (message: ExtToRelayMessage) => void) {
		this.#api = api;
		this.#emit = emit;
		this.ready = this.#restore();
		api.windows.onRemoved.addListener(windowId => {
			if (windowId === this.#windowId) void this.#forgetWindow();
		});
		api.tabs.onCreated.addListener(tab => this.#publish(tab, "tabCreated"));
		api.tabs.onUpdated.addListener((_id, _change, tab) => this.#publish(tab, "tabUpdated"));
		api.tabs.onActivated.addListener(info => {
			if (info.windowId !== this.#windowId) return;
			void api.tabs.query({ windowId: info.windowId }).then(tabs => {
				for (const tab of tabs) this.#publish(tab, "tabUpdated");
			});
		});
		api.tabs.onDetached.addListener((tabId, info) => {
			this.#joining.delete(tabId);
			if (info.oldWindowId === this.#windowId) void this.#retract(tabId);
		});
		api.tabs.onAttached.addListener((tabId, info) => {
			if (info.newWindowId === this.#windowId) {
				const transfer = ++this.#joinSequence;
				this.#joining.set(tabId, transfer);
				void api.tabs
					.get(tabId)
					.then(tab => {
						if (this.#joining.get(tabId) !== transfer) return;
						this.#joining.delete(tabId);
						this.#publish(tab, "tabCreated");
					})
					.catch(() => {
						if (this.#joining.get(tabId) === transfer) this.#joining.delete(tabId);
					});
			}
		});
		api.tabs.onRemoved.addListener((tabId, info) => {
			// Chrome removes tabs before the final window event; never reuse a closing window.
			if (info.isWindowClosing && info.windowId === this.#windowId) void this.#forgetWindow();
			this.#joining.delete(tabId);
			void this.#retract(tabId);
		});
		api.debugger.onDetach.addListener((source, reason) => {
			const tabId = source.tabId;
			if (tabId === undefined || !this.#attached.delete(tabId)) return;
			this.#cancelViews(tabId);
			this.#children.delete(tabId);
			void this.#persist();
			this.#emit({ t: "detached", tabId, reason, relayInitiated: this.#detaching.has(tabId) });
		});
		api.debugger.onEvent.addListener((source, method, params) => {
			void this.#debuggerEvent(source, method, params);
		});
	}

	async #restore(): Promise<void> {
		const stored = await this.#api.storage.session.get({
			[SESSION_KEY]: null,
			[ATTACHED_KEY]: [],
			[BROWSER_SESSION_KEY]: "",
		});
		const browserSession = stored[BROWSER_SESSION_KEY];
		this.#browserSession =
			typeof browserSession === "string" && browserSession.length > 0 ? browserSession : crypto.randomUUID();
		const id = stored[SESSION_KEY];
		if (typeof id === "number" && Number.isInteger(id)) {
			const window = await this.#api.windows.get(id).catch(() => null);
			if (window?.id === id && window.type === "normal") {
				this.#windowId = id;
				for (const tab of await this.#api.tabs.query({ windowId: id })) {
					if (tab.id !== undefined) this.#known.add(tab.id);
				}
			}
		}
		// A suspended worker may leave attachments on tabs that have since moved out.
		const oldIds = stored[ATTACHED_KEY];
		if (Array.isArray(oldIds)) {
			for (const id of oldIds) {
				if (typeof id !== "number") continue;
				await this.#api.debugger
					.sendCommand({ tabId: id }, "Emulation.setFocusEmulationEnabled", { enabled: false })
					.catch(() => {});
				await this.#api.debugger.detach({ tabId: id }).catch(() => {});
			}
		}
		await this.#persist();
	}

	#persist(): Promise<void> {
		const next = this.#storageOps.then(() =>
			this.#api.storage.session.set({
				[SESSION_KEY]: this.#windowId,
				[ATTACHED_KEY]: [...this.#attached],
				[BROWSER_SESSION_KEY]: this.#browserSession,
			}),
		);
		this.#storageOps = next.catch(() => {});
		return next;
	}

	#snapshot(tab: ChromeTab): TabSnapshot | null {
		if (this.#windowId === null || tab.windowId !== this.#windowId || tab.id === undefined) return null;
		return {
			tabId: tab.id,
			url: tab.url ?? tab.pendingUrl ?? "",
			title: tab.title ?? "",
			active: tab.active,
			discarded: tab.discarded === true,
			windowId: tab.windowId,
		};
	}

	#publish(tab: ChromeTab, t: "tabCreated" | "tabUpdated"): void {
		const snapshot = this.#snapshot(tab);
		if (!snapshot) {
			if (tab.id !== undefined) void this.#retract(tab.id);
			return;
		}
		if (snapshot.discarded) this.#cancelViews(snapshot.tabId, "Chrome discarded the workspace tab");
		this.#known.add(snapshot.tabId);
		this.#emit({ t, tab: snapshot });
	}

	async #retract(tabId: number): Promise<void> {
		this.#cancelViews(tabId, `Tab ${tabId} is not in the dedicated agent window`);
		if (this.#known.delete(tabId)) this.#emit({ t: "tabRemoved", tabId });
		if (this.#attached.has(tabId) || this.#attaching.has(tabId)) await this.#detach(tabId).catch(() => {});
	}

	async #forgetWindow(): Promise<void> {
		// Fresh-page requests may provision the replacement; only old tab work is cancelled.
		for (const view of this.#views) {
			if (view.tabId !== undefined) view.cancel("Dedicated agent window was closed");
		}
		this.#joining.clear();
		this.#windowId = null;
		this.#emit({ t: "workspace", windowId: null });
		for (const id of this.#known) void this.#retract(id);
		await this.#persist();
	}

	async #owned(tabId: number): Promise<ChromeTab> {
		const tab = await this.#api.tabs.get(tabId).catch(() => null);
		if (!tab || this.#windowId === null || tab.windowId !== this.#windowId) {
			void this.#retract(tabId);
			throw new Error(`Tab ${tabId} is not in the dedicated agent window`);
		}
		return tab;
	}

	async #liveWindow(allowReplacement = false): Promise<void> {
		const id = this.#windowId;
		if (id === null) return;
		const window = await this.#api.windows.get(id).catch(() => null);
		if (id !== this.#windowId) {
			if (allowReplacement && this.#windowId === null) return;
			throw new Error("Dedicated agent window changed");
		}
		if (!window) {
			await this.#forgetWindow();
			if (!allowReplacement) throw new Error("Dedicated agent window was closed");
		}
	}

	#cancelViews(tabId?: number, reason?: string): void {
		for (const view of this.#views) {
			if (tabId === undefined || view.tabId === tabId) view.cancel(reason);
		}
	}

	#check(view: ViewOperation): void {
		if (view.epoch !== this.#epoch) throw new Error("Relay disconnected before command dispatch");
		if (view.cancelled) throw new Error(view.reason);
	}

	#withView<T>(epoch: number, tabId: number | undefined, operation: (view: ViewOperation) => Promise<T>): Promise<T> {
		const cancelled = Promise.withResolvers<void>();
		const unlocked = Promise.withResolvers<void>();
		const view: ViewOperation = {
			epoch,
			tabId,
			cancelled: false,
			reason: "Workspace control was interrupted before command dispatch",
			interrupted: cancelled.promise,
			cancel(reason) {
				if (this.cancelled) return;
				this.cancelled = true;
				if (reason) this.reason = reason;
				cancelled.resolve();
			},
			release: unlocked.resolve,
		};
		this.#views.add(view);
		const next = this.#viewTail.then(async () => {
			this.#check(view);
			return operation(view);
		});
		this.#viewTail = unlocked.promise;
		void next
			.finally(() => {
				unlocked.resolve();
				this.#views.delete(view);
			})
			.catch(() => {});
		return next;
	}

	async #authorize(view: ViewOperation, tabId?: number): Promise<ChromeTab | null> {
		this.#check(view);
		await this.#liveWindow(tabId === undefined);
		const tab = tabId === undefined ? null : await this.#owned(tabId);
		this.#check(view);
		return tab;
	}

	async #select(tabId: number, view: ViewOperation): Promise<void> {
		const tab = await this.#authorize(view, tabId);
		if (!tab?.active) {
			await this.#api.tabs.update(tabId, { active: true });
			await this.#authorize(view, tabId);
		}
	}

	async hello(instanceId: string, userAgent: string): Promise<ExtToRelayMessage> {
		await this.ready;
		await this.#liveWindow().catch(() => {});
		const tabs = this.#windowId === null ? [] : await this.#api.tabs.query({ windowId: this.#windowId });
		const snapshots: TabSnapshot[] = [];
		for (const tab of tabs) {
			const snapshot = this.#snapshot(tab);
			if (snapshot) snapshots.push(snapshot);
		}
		return {
			t: "hello",
			protocolVersion: RELAY_PROTOCOL_VERSION,
			discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION,
			browserSession: this.#browserSession,
			instanceId,
			userAgent,
			browserVersion: /Chrome\/[\d.]+/.exec(userAgent)?.[0] ?? "Chrome/unknown",
			workspaceWindowId: this.#windowId,
			tabs: snapshots,
			attachedTabIds: snapshots.filter(tab => this.#attached.has(tab.tabId)).map(tab => tab.tabId),
		};
	}

	async #createTab(url: string, view: ViewOperation): Promise<ChromeTab> {
		await this.#authorize(view);
		if (this.#windowId === null) {
			const window = await this.#api.windows.create({ url, focused: false, type: "normal" });
			if (window?.id === undefined) throw new Error("Chrome did not create a dedicated agent window");
			this.#windowId = window.id;
			try {
				await this.#persist();
			} catch (error) {
				this.#windowId = null;
				throw error;
			}
			await this.#authorize(view);
			this.#emit({ t: "workspace", windowId: window.id });
			const tabs = await this.#api.tabs.query({ windowId: window.id });
			const tab = tabs[0];
			if (tab?.id === undefined) throw new Error("Chrome did not create an initial workspace tab");
			await this.#authorize(view, tab.id);
			for (const current of tabs) this.#publish(current, "tabCreated");
			return tab;
		}
		const tab = await this.#api.tabs.create({ url, windowId: this.#windowId, active: true });
		await this.#authorize(view, tab.id ?? -1);
		return tab;
	}

	async #attach(tabId: number, view: ViewOperation): Promise<void> {
		const existing = this.#attaching.get(tabId);
		if (existing) return existing;
		if (this.#detaching.has(tabId)) await this.#detaching.get(tabId);
		if (this.#attached.has(tabId)) return;
		const operation = (async () => {
			const tab = await this.#authorize(view, tabId);
			if (tab?.discarded) throw new Error("Cannot attach to a discarded workspace tab");
			await this.#api.debugger.attach({ tabId }, "1.3");
			this.#attached.add(tabId);
			try {
				const attached = await this.#authorize(view, tabId);
				if (attached?.discarded) throw new Error("Chrome discarded the workspace tab while attaching");
				// A mapped native widget must retain real user focus, never emulated focus.
				await this.#api.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false });
				await this.#authorize(view, tabId);
				await this.#persist();
			} catch (error) {
				await this.#api.debugger.detach({ tabId }).catch(() => {});
				this.#attached.delete(tabId);
				await this.#persist();
				throw error;
			}
		})();
		this.#attaching.set(tabId, operation);
		try {
			await operation;
		} finally {
			this.#attaching.delete(tabId);
		}
	}

	async #detach(tabId: number): Promise<void> {
		this.#cancelViews(tabId);
		const existing = this.#detaching.get(tabId);
		if (existing) return existing;
		const operation = (async () => {
			await this.#attaching.get(tabId)?.catch(() => {});
			if (!this.#attached.has(tabId)) return;
			await this.#api.debugger.detach({ tabId });
			if (this.#attached.delete(tabId))
				this.#emit({ t: "detached", tabId, reason: "relay_detached", relayInitiated: true });
			this.#children.delete(tabId);
			await this.#persist();
		})();
		this.#detaching.set(tabId, operation);
		try {
			await operation;
		} finally {
			this.#detaching.delete(tabId);
		}
	}

	async releaseAll(): Promise<void> {
		++this.#epoch;
		this.#cancelViews();
		await this.ready;
		await Promise.allSettled(this.#attaching.values());
		await Promise.all([...this.#attached].map(id => this.#detach(id).catch(() => {})));
	}

	async #debuggerEvent(
		source: ChromeDebuggerSession,
		method: string,
		params?: Record<string, unknown>,
	): Promise<void> {
		const tabId = source.tabId;
		if (tabId === undefined || !this.#attached.has(tabId)) return;
		try {
			await this.#owned(tabId);
		} catch {
			return;
		}
		if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") {
			const targetInfo = params.targetInfo;
			if (
				targetInfo &&
				typeof targetInfo === "object" &&
				"targetId" in targetInfo &&
				typeof targetInfo.targetId === "string"
			) {
				const children = this.#children.get(tabId) ?? new Map<string, string>();
				children.set(params.sessionId, targetInfo.targetId);
				this.#children.set(tabId, children);
			}
		} else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
			this.#children.get(tabId)?.delete(params.sessionId);
		}
		this.#emit({ t: "cdpEvent", tabId, sessionId: source.sessionId, method, params });
	}

	async #targetOwned(tabId: number, targetId: unknown): Promise<boolean> {
		if (typeof targetId !== "string") return false;
		const children = this.#children.get(tabId);
		if (children) {
			for (const childId of children.values()) if (childId === targetId) return true;
		}
		const info = await this.#api.debugger.sendCommand({ tabId }, "Target.getTargetInfo");
		const target = info?.targetInfo;
		return target !== null && typeof target === "object" && "targetId" in target && target.targetId === targetId;
	}

	async #send(msg: Extract<RelayRpcRequest, { op: "send" }>, epoch: number, view?: ViewOperation): Promise<unknown> {
		if (!this.#attached.has(msg.tabId)) throw new Error("Tab is not attached by this relay");
		if (msg.sessionId && !this.#children.get(msg.tabId)?.has(msg.sessionId))
			throw new Error("Unknown workspace child session");
		if (epoch !== this.#epoch) throw new Error("Relay disconnected before command dispatch");
		const { method, params } = msg;
		if (method === "Emulation.setFocusEmulationEnabled") {
			if (msg.sessionId) throw new Error("Focus emulation must address the workspace page");
			if (typeof params?.enabled !== "boolean") throw new Error("Focus emulation requires a boolean enabled value");
			await this.#owned(msg.tabId);
			return this.#api.debugger.sendCommand({ tabId: msg.tabId }, method, { enabled: false });
		}
		if (method === "Page.setDownloadBehavior") throw new Error(`Unsupported native UI command: ${method}`);
		if (method === "Page.bringToFront" || method === "Target.activateTarget") {
			if (method === "Target.activateTarget" && !(await this.#targetOwned(msg.tabId, params?.targetId)))
				throw new Error("Target is not owned by this workspace tab");
			if (!view) throw new Error("Native selection requires a workspace view");
			await this.#select(msg.tabId, view);
			return {};
		}
		if (method.startsWith("Target.")) {
			if (method === "Target.setAutoAttach") {
				if (params?.flatten !== true) throw new Error("Workspace auto-attach requires flat child sessions");
			} else if (method === "Target.getTargetInfo") {
				if (params?.targetId !== undefined && !(await this.#targetOwned(msg.tabId, params.targetId)))
					throw new Error("Target is outside the workspace tab");
			} else if (method === "Target.detachFromTarget") {
				if (typeof params?.sessionId !== "string" || !this.#children.get(msg.tabId)?.has(params.sessionId))
					throw new Error("Unknown workspace child session");
			} else {
				throw new Error(`Unsupported global target command: ${method}`);
			}
		} else if (!Object.hasOwn(PAGE_DOMAINS, method.split(".")[0] ?? "")) {
			throw new Error(`Unsupported browser or native command: ${method}`);
		}
		if (view) await this.#select(msg.tabId, view);
		else await this.#owned(msg.tabId);
		if (epoch !== this.#epoch) throw new Error("Relay disconnected before command dispatch");
		if (!this.#attached.has(msg.tabId)) throw new Error("Tab is not attached by this relay");
		if (view) this.#check(view);
		const command = this.#api.debugger.sendCommand(
			msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
			method,
			params,
		);
		// Runtime promises may await later input or cancellation; only native preparation is serialized.
		if (method.startsWith("Runtime.")) view?.release();
		return view
			? Promise.race([
					command,
					view.interrupted.then(() => {
						this.#check(view);
						throw new Error("Workspace control was interrupted");
					}),
				])
			: command;
	}

	async runRpc(msg: RelayRpcRequest): Promise<unknown> {
		const epoch = this.#epoch;
		await this.ready;
		if (epoch !== this.#epoch) throw new Error("Relay disconnected before control started");
		if (msg.op === "detach") {
			await this.#detach(msg.tabId);
			return {};
		}
		if (
			msg.op === "send" &&
			(isWorkspaceCleanupCommand(msg.method, msg.params) ||
				msg.method === "Page.handleJavaScriptDialog" ||
				msg.method === "Emulation.setFocusEmulationEnabled")
		) {
			await this.#owned(msg.tabId);
			return this.#send(msg, epoch);
		}
		return this.#withView(epoch, msg.op === "createTab" ? undefined : msg.tabId, async view => {
			await this.#authorize(view, msg.op === "createTab" ? undefined : msg.tabId);
			if (msg.op === "createTab") {
				const tab = await this.#createTab(msg.url, view);
				const snapshot = this.#snapshot(tab);
				if (!snapshot) throw new Error("Created tab escaped the dedicated agent window");
				return { tab: snapshot };
			}
			switch (msg.op) {
				case "attach":
					await this.#attach(msg.tabId, view);
					return {};
				case "send":
					return this.#send(msg, epoch, view);
				case "removeTab":
					view.tabId = undefined;
					await this.#api.tabs.remove(msg.tabId);
					return {};
				case "activateTab":
					await this.#select(msg.tabId, view);
					return {};
			}
			throw new Error("Unsupported workspace RPC operation");
		});
	}
}
