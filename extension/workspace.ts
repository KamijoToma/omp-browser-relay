import {
	DISCARDED_TABS_PROTOCOL_VERSION,
	isWorkspaceCleanupCommand,
	RELAY_PROTOCOL_VERSION,
	type ExtToRelayMessage,
	type RelayRpcRequest,
	type TabSnapshot,
} from "../src/protocol";

const SESSION_KEY = "workspaceWindowId";
const GUARD_KEY = "workspaceGuardTabId";
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

/** Owns one explicitly created window, never inferring ownership from titles or the current window. */
export class Workspace {
	readonly ready: Promise<void>;
	#api: ChromeApi;
	#emit: (message: ExtToRelayMessage) => void;
	#windowId: number | null = null;
	#guardId: number | null = null;
	#guardCreating = false;
	#paused = false;
	#browserSession = "";
	#known = new Set<number>();
	#attached = new Set<number>();
	#attaching = new Map<number, Promise<void>>();
	#detaching = new Map<number, Promise<void>>();
	#children = new Map<number, Map<string, string>>();
	#focusOps = new Map<number, Promise<void>>();
	#focusState = new Map<number, boolean>();
	// Native selection and pause temporarily override this logical client request.
	#focusRequested = new Map<number, boolean>();
	#inputFrames = new Set<number>();
	#publicFrames = new Set<number>();
	#pauseTransition: Promise<void> = Promise.resolve();
	#storageOps: Promise<void> = Promise.resolve();
	#viewTail: Promise<void> = Promise.resolve();
	#views = new Set<ViewOperation>();
	#epoch = 0;

	constructor(api: ChromeApi, emit: (message: ExtToRelayMessage) => void) {
		this.#api = api;
		this.#emit = emit;
		this.ready = this.#restore();
		api.windows.onFocusChanged.addListener(windowId => {
			if (this.#windowId !== null) void this.#setPaused(windowId === this.#windowId);
		});
		api.windows.onRemoved.addListener(windowId => {
			if (windowId === this.#windowId) void this.#forgetWindow();
		});
		api.tabs.onCreated.addListener(tab => this.#publish(tab, "tabCreated"));
		api.tabs.onUpdated.addListener((_id, _change, tab) => this.#publish(tab, "tabUpdated"));
		api.tabs.onActivated.addListener(info => {
			if (info.windowId !== this.#windowId) return;
			// A native selection must never leave focus emulation on its mapped widget.
			void this.#focus(info.tabId, false).catch(() => {});
			void api.tabs.query({ windowId: info.windowId }).then(tabs => {
				for (const tab of tabs) this.#publish(tab, "tabUpdated");
			});
		});
		api.tabs.onDetached.addListener((tabId, info) => {
			if (info.oldWindowId === this.#windowId) void this.#retract(tabId);
		});
		api.tabs.onAttached.addListener((tabId, info) => {
			if (info.newWindowId === this.#windowId) {
				void api.tabs
					.get(tabId)
					.then(tab => this.#publish(tab, "tabCreated"))
					.catch(() => {});
			}
		});
		api.tabs.onRemoved.addListener((tabId, info) => {
			// Tab removal precedes windows.onRemoved; never create into a window
			// Chrome has begun closing while its window metadata still exists.
			if (info.isWindowClosing && info.windowId === this.#windowId) void this.#forgetWindow();
			void this.#retract(tabId);
		});
		api.debugger.onDetach.addListener((source, reason) => {
			const tabId = source.tabId;
			if (tabId === undefined || !this.#attached.delete(tabId)) return;
			this.#cancelViews(tabId);
			this.#focusState.delete(tabId);
			this.#focusRequested.delete(tabId);
			this.#inputFrames.delete(tabId);
			this.#publicFrames.delete(tabId);
			this.#children.delete(tabId);
			void this.#persist();
			this.#emit({ t: "detached", tabId, reason, relayInitiated: this.#detaching.has(tabId) });
		});
		api.debugger.onEvent.addListener((source, method, params) => {
			void this.#debuggerEvent(source, method, params);
		});
	}

	#getGuardUrl(): string {
		return this.#api.runtime.getURL("workspace.html");
	}

	#isGuard(tab: ChromeTab): boolean {
		return (
			tab.id === this.#guardId &&
			tab.windowId === this.#windowId &&
			(tab.pendingUrl ?? tab.url) === this.#getGuardUrl()
		);
	}

	async #restore(): Promise<void> {
		const stored = await this.#api.storage.session.get({
			[SESSION_KEY]: null,
			[GUARD_KEY]: null,
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
				this.#paused = window.focused;
				const guardId = stored[GUARD_KEY];
				if (typeof guardId === "number" && Number.isInteger(guardId)) this.#guardId = guardId;
				await this.#validateGuard();
				for (const tab of await this.#api.tabs.query({ windowId: id })) {
					if (tab.id !== undefined && tab.id !== this.#guardId) this.#known.add(tab.id);
				}
			}
		}
		// Chrome may keep debugger attachments across a worker restart. Release only
		// this extension's persisted attachments, including tabs moved while asleep.
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
				[GUARD_KEY]: this.#guardId,
				[ATTACHED_KEY]: [...this.#attached],
				[BROWSER_SESSION_KEY]: this.#browserSession,
			}),
		);
		this.#storageOps = next.catch(() => {});
		return next;
	}

	#snapshot(tab: ChromeTab): TabSnapshot | null {
		if (
			this.#windowId === null ||
			tab.windowId !== this.#windowId ||
			tab.id === undefined ||
			tab.id === this.#guardId
		)
			return null;
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
		// Chrome emits onCreated before tabs.create resolves with the reserved ID.
		// Buffer discovery during that short interval; do not identify guards by URL.
		if (this.#guardCreating && tab.windowId === this.#windowId) return;
		if (tab.id === this.#guardId) {
			if (this.#isGuard(tab)) return;
			this.#guardId = null;
			void this.#persist();
		}
		const snapshot = this.#snapshot(tab);
		if (!snapshot) {
			if (tab.id !== undefined) void this.#retract(tab.id);
			return;
		}
		if (snapshot.discarded) this.#cancelViews(snapshot.tabId, "Chrome discarded the workspace tab");
		this.#known.add(snapshot.tabId);
		this.#emit({ t, tab: snapshot });
	}

	async #validateGuard(): Promise<ChromeTab | null> {
		if (this.#guardId === null) return null;
		const id = this.#guardId;
		const tab = await this.#api.tabs.get(id).catch(() => null);
		if (id !== this.#guardId) return null;
		if (tab && this.#isGuard(tab)) return tab;
		this.#guardId = null;
		await this.#persist();
		if (tab) this.#publish(tab, "tabCreated");
		return null;
	}

	async #retract(tabId: number): Promise<void> {
		if (tabId === this.#guardId) {
			this.#guardId = null;
			void this.#persist();
		}
		this.#cancelViews(tabId, `Tab ${tabId} is not in the dedicated agent window`);
		if (this.#known.delete(tabId)) this.#emit({ t: "tabRemoved", tabId });
		if (this.#attached.has(tabId) || this.#attaching.has(tabId)) await this.#detach(tabId).catch(() => {});
	}

	async #forgetWindow(): Promise<void> {
		this.#cancelViews();
		this.#windowId = null;
		this.#guardId = null;
		this.#paused = false;
		this.#emit({ t: "workspace", windowId: null, paused: false });
		for (const id of this.#known) void this.#retract(id);
		await this.#persist();
	}

	async #owned(tabId: number): Promise<ChromeTab> {
		await this.#validateGuard();
		const tab = await this.#api.tabs.get(tabId).catch(() => null);
		if (!tab || this.#windowId === null || tab.windowId !== this.#windowId) {
			void this.#retract(tabId);
			throw new Error(`Tab ${tabId} is not in the dedicated agent window`);
		}
		if (tabId === this.#guardId) throw new Error("The workspace guard is reserved and cannot be controlled");
		return tab;
	}

	async #controlAllowed(): Promise<void> {
		if (this.#windowId !== null) {
			const window = await this.#api.windows.get(this.#windowId).catch(() => null);
			if (!window) {
				await this.#forgetWindow();
				throw new Error("Dedicated agent window was closed");
			}
			const transition = this.#setPaused(window.focused);
			if (this.#paused) {
				void transition.catch(() => {});
				throw new Error("Agent control is paused while you focus the dedicated agent window");
			}
			await transition;
		}
		await Promise.all(this.#focusOps.values());
		if (this.#paused) throw new Error("Agent control is paused while you focus the dedicated agent window");
	}

	#focus(tabId: number, enabled: boolean): Promise<void> {
		const previous = this.#focusOps.get(tabId) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(async () => {
				if (!this.#attached.has(tabId)) return;
				let desired = enabled && this.#focusRequested.get(tabId) !== false && !this.#paused;
				if (desired) {
					const tab = await this.#owned(tabId);
					desired = !tab.active && this.#focusRequested.get(tabId) !== false && !this.#paused;
				}
				if (!this.#attached.has(tabId) || this.#focusState.get(tabId) === desired) return;
				await this.#api.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: desired });
				if (this.#attached.has(tabId)) this.#focusState.set(tabId, desired);
			});
		this.#focusOps.set(tabId, next);
		void next
			.finally(() => {
				if (this.#focusOps.get(tabId) === next) this.#focusOps.delete(tabId);
			})
			.catch(() => {});
		return next;
	}

	async #setPaused(paused: boolean): Promise<void> {
		if (this.#paused === paused) return this.#pauseTransition;
		this.#paused = paused;
		if (paused) this.#cancelViews();
		this.#emit({ t: "workspace", windowId: this.#windowId, paused });
		const transition = this.#pauseTransition
			.catch(() => {})
			.then(async () => {
				await Promise.all(
					[...this.#attached].map(async tabId => {
						try {
							await this.#owned(tabId);
							if (paused) await this.#stopInputFrames(tabId);
							await this.#focus(tabId, !paused);
						} catch {
							void this.#detach(tabId).catch(() => {});
						}
					}),
				);
			});
		this.#pauseTransition = transition;
		await transition;
	}

	#cancelViews(tabId?: number, reason?: string): void {
		for (const view of this.#views) {
			if (tabId === undefined || view.tabId === tabId) view.cancel(reason);
		}
	}

	#check(view: ViewOperation): void {
		if (view.epoch !== this.#epoch) throw new Error("Relay disconnected before command dispatch");
		if (this.#paused) throw new Error("Agent control is paused while you focus the dedicated agent window");
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
		await this.#controlAllowed();
		const tab = tabId === undefined ? null : await this.#owned(tabId);
		this.#check(view);
		return tab;
	}

	async #ensureGuard(view: ViewOperation): Promise<ChromeTab> {
		const guard = await this.#validateGuard();
		this.#check(view);
		if (guard) return guard;
		await this.#authorize(view);
		if (this.#windowId === null) throw new Error("Dedicated agent window was closed");
		const windowId = this.#windowId;
		this.#guardCreating = true;
		try {
			const created = await this.#api.tabs.create({ windowId, url: this.#getGuardUrl(), active: false });
			if (
				created.id === undefined ||
				created.windowId !== this.#windowId ||
				(created.pendingUrl ?? created.url) !== this.#getGuardUrl()
			) {
				throw new Error("Chrome did not create a workspace guard");
			}
			this.#guardId = created.id;
			await this.#persist();
			this.#check(view);
			return created;
		} finally {
			this.#guardCreating = false;
			if (this.#windowId !== null) {
				for (const tab of await this.#api.tabs.query({ windowId: this.#windowId }))
					this.#publish(tab, "tabUpdated");
			}
		}
	}

	async #prepareInactive(tabId: number, view: ViewOperation): Promise<void> {
		await this.#authorize(view, tabId);
		let guard = await this.#ensureGuard(view);
		while (!guard.active) {
			await this.#authorize(view, tabId);
			const current = await this.#validateGuard();
			this.#check(view);
			if (!current) {
				guard = await this.#ensureGuard(view);
				continue;
			}
			// Revalidate the reserved ID immediately before selecting its native view.
			await this.#api.tabs.update(current.id!, { active: true });
			break;
		}
		await this.#authorize(view, tabId);
		await this.#focus(tabId, true);
		const tab = await this.#authorize(view, tabId);
		if (tab?.active || this.#focusState.get(tabId) !== (this.#focusRequested.get(tabId) !== false))
			throw new Error("Could not isolate an inactive workspace view");
	}

	async #select(tabId: number, view: ViewOperation): Promise<void> {
		await this.#authorize(view, tabId);
		await this.#focus(tabId, false);
		await this.#authorize(view, tabId);
		await this.#api.tabs.update(tabId, { active: true });
		await this.#authorize(view, tabId);
	}

	async hello(instanceId: string, userAgent: string): Promise<ExtToRelayMessage> {
		await this.ready;
		await this.#controlAllowed().catch(() => {});
		await this.#validateGuard();
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
			workspacePaused: this.#paused,
			tabs: snapshots,
			attachedTabIds: snapshots.filter(tab => this.#attached.has(tab.tabId)).map(tab => tab.tabId),
		};
	}

	async #createTab(url: string, view: ViewOperation): Promise<ChromeTab> {
		await this.#authorize(view);
		if (this.#windowId === null) {
			this.#guardCreating = true;
			try {
				const window = await this.#api.windows.create({ url: this.#getGuardUrl(), focused: false, type: "normal" });
				if (window?.id === undefined) throw new Error("Chrome did not create a dedicated agent window");
				this.#windowId = window.id;
				this.#paused = window.focused;
				const tabs = await this.#api.tabs.query({ windowId: window.id });
				const guard = tabs[0];
				if (guard?.id !== undefined && (guard.pendingUrl ?? guard.url) === this.#getGuardUrl())
					this.#guardId = guard.id;
				try {
					await this.#persist();
				} catch (error) {
					this.#windowId = null;
					this.#guardId = null;
					this.#paused = false;
					throw error;
				}
				this.#emit({ t: "workspace", windowId: window.id, paused: this.#paused });
			} finally {
				this.#guardCreating = false;
			}
		}
		await this.#ensureGuard(view);
		await this.#authorize(view);
		const tab = await this.#api.tabs.create({ url, windowId: this.#windowId!, active: false });
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
				await this.#persist();
				await this.#prepareInactive(tabId, view);
			} catch (error) {
				await this.#focus(tabId, false).catch(() => {});
				await this.#api.debugger.detach({ tabId }).catch(() => {});
				this.#attached.delete(tabId);
				this.#focusState.delete(tabId);
				this.#focusRequested.delete(tabId);
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

	async #stopInputFrames(tabId: number): Promise<void> {
		if (!this.#inputFrames.delete(tabId)) return;
		await this.#api.debugger.sendCommand({ tabId }, "Page.stopScreencast");
	}

	async #startInputFrames(tabId: number, view: ViewOperation): Promise<void> {
		if (this.#inputFrames.has(tabId) || this.#publicFrames.has(tabId)) return;
		await this.#select(tabId, view);
		this.#inputFrames.add(tabId);
		try {
			// A hidden emulated viewport needs drawing to acknowledge captured
			// pointer moves. Keep it drawing for the gesture, never while idle.
			await this.#api.debugger.sendCommand({ tabId }, "Page.startScreencast", {
				format: "jpeg",
				quality: 1,
				maxWidth: 1,
				maxHeight: 1,
			});
			await this.#prepareInactive(tabId, view);
		} catch (error) {
			await this.#stopInputFrames(tabId).catch(() => {});
			throw error;
		}
	}

	async #detach(tabId: number): Promise<void> {
		this.#cancelViews(tabId);
		const existing = this.#detaching.get(tabId);
		if (existing) return existing;
		const operation = (async () => {
			await this.#attaching.get(tabId)?.catch(() => {});
			if (!this.#attached.has(tabId)) {
				this.#focusRequested.delete(tabId);
				return;
			}
			await this.#focus(tabId, false).catch(() => {});
			await this.#stopInputFrames(tabId).catch(() => {});
			this.#publicFrames.delete(tabId);
			await this.#api.debugger.detach({ tabId });
			if (this.#attached.delete(tabId))
				this.#emit({ t: "detached", tabId, reason: "relay_detached", relayInitiated: true });
			this.#focusState.delete(tabId);
			this.#focusRequested.delete(tabId);
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
		this.#focusRequested.clear();
	}

	async #debuggerEvent(
		source: ChromeDebuggerSession,
		method: string,
		params?: Record<string, unknown>,
	): Promise<void> {
		const tabId = source.tabId;
		if (tabId === undefined || !this.#attached.has(tabId)) return;
		if (method.startsWith("Page.screencast") && !this.#publicFrames.has(tabId)) {
			if (method === "Page.screencastFrame" && typeof params?.sessionId === "number")
				void this.#api.debugger
					.sendCommand({ tabId }, "Page.screencastFrameAck", { sessionId: params.sessionId })
					.catch(() => {});
			return;
		}
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
			if (typeof params?.enabled !== "boolean") throw new Error("Focus emulation requires a boolean enabled value");
			if (params.enabled) {
				if (!view) throw new Error("Enabling focus emulation requires a workspace view");
				this.#focusRequested.set(msg.tabId, true);
				await this.#prepareInactive(msg.tabId, view);
			} else {
				// Cleanup must not wait for Runtime/capture completion, select a view,
				// or forget the request when pause and capture overrides are lifted.
				this.#focusRequested.set(msg.tabId, false);
				await this.#focus(msg.tabId, false);
				await this.#stopInputFrames(msg.tabId);
			}
			return {};
		}
		if (method === "Page.setDownloadBehavior") throw new Error(`Unsupported native UI command: ${method}`);
		if (method === "Page.bringToFront" || method === "Target.activateTarget") {
			if (method === "Target.activateTarget" && !(await this.#targetOwned(msg.tabId, params?.targetId))) {
				throw new Error("Target is not owned by this workspace tab");
			}
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
		const viewport = method === "Page.captureScreenshot" || method === "Page.startScreencast";
		if (view) {
			if (viewport) await this.#select(msg.tabId, view);
			else await this.#prepareInactive(msg.tabId, view);
		} else {
			if (!isWorkspaceCleanupCommand(method, params)) await this.#controlAllowed();
			await this.#owned(msg.tabId);
		}
		if (
			view &&
			method === "Input.dispatchMouseEvent" &&
			(params?.type === "mousePressed" || (typeof params?.buttons === "number" && params.buttons > 0))
		)
			await this.#startInputFrames(msg.tabId, view);
		if (method === "Page.startScreencast") await this.#stopInputFrames(msg.tabId);
		if (epoch !== this.#epoch) throw new Error("Relay disconnected before command dispatch");
		if (!this.#attached.has(msg.tabId)) throw new Error("Tab is not attached by this relay");
		if (view) this.#check(view);
		else if (!isWorkspaceCleanupCommand(method, params) && this.#paused)
			throw new Error("Agent control is paused while you focus the dedicated agent window");
		try {
			if (method === "Page.startScreencast") this.#publicFrames.add(msg.tabId);
			const command = this.#api.debugger.sendCommand(
				msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
				method,
				params,
			);
			// Awaited page promises must not lock out the commands that cancel them.
			// Ownership/cancellation stays live after native preparation is released.
			if (method.startsWith("Runtime.")) view?.release();
			// Only an already-dispatched CDP command may release the lock early.
			// Native tab/window transitions must finish before another view can run.
			return await (view
				? Promise.race([
						command,
						view.interrupted.then(() => {
							this.#check(view);
							throw new Error("Workspace control was interrupted");
						}),
					])
				: command);
		} catch (error) {
			if (method === "Page.startScreencast" && epoch === this.#epoch) {
				this.#publicFrames.delete(msg.tabId);
				await this.#api.debugger.sendCommand({ tabId: msg.tabId }, "Page.stopScreencast").catch(() => {});
			}
			throw error;
		} finally {
			if (method === "Page.stopScreencast" && epoch === this.#epoch) this.#publicFrames.delete(msg.tabId);
			if (
				epoch === this.#epoch &&
				method === "Input.dispatchMouseEvent" &&
				params?.type === "mouseReleased" &&
				(!params.buttons || params.buttons === 0)
			)
				await this.#stopInputFrames(msg.tabId).catch(() => {});
			// A late screenshot completion must not select a tab after user takeover,
			// migration, detach, or a new relay connection has invalidated this work.
			if (
				viewport &&
				view &&
				!view.cancelled &&
				epoch === this.#epoch &&
				this.#attached.has(msg.tabId) &&
				!this.#paused
			) {
				await this.#prepareInactive(msg.tabId, view).catch(() => {});
			}
		}
	}

	async runRpc(msg: RelayRpcRequest): Promise<unknown> {
		// Capture at receipt, not when this request eventually reaches the view queue.
		const epoch = this.#epoch;
		await this.ready;
		if (epoch !== this.#epoch) throw new Error("Relay disconnected before control started");
		if (msg.op === "detach") {
			await this.#validateGuard();
			if (msg.tabId === this.#guardId) throw new Error("The workspace guard is reserved and cannot be controlled");
			if (epoch !== this.#epoch) throw new Error("Relay disconnected before control started");
			await this.#detach(msg.tabId);
			return {};
		}
		if (
			msg.op === "send" &&
			(isWorkspaceCleanupCommand(msg.method, msg.params) || msg.method === "Page.handleJavaScriptDialog")
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
					// onRemoved retracts other work; completing this removal is not interrupted by its own event.
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
