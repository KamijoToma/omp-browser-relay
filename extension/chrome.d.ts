/** Dependency-free subset of promise-based MV3 APIs used by this extension. */
interface ChromeEvent<T extends (...args: never[]) => void> {
	addListener(callback: T): void;
	removeListener(callback: T): void;
}

interface ChromeTab {
	id?: number;
	url?: string;
	pendingUrl?: string;
	title?: string;
	active: boolean;
	discarded?: boolean;
	windowId: number;
}

interface ChromeWindow {
	id?: number;
	focused: boolean;
	type?: string;
	tabs?: ChromeTab[];
}

interface ChromeTabChangeInfo {
	url?: string;
	title?: string;
	status?: string;
	discarded?: boolean;
}

/** Chrome 125+ flat child sessions are scoped to their root tab. */
interface ChromeDebuggerSession {
	tabId?: number;
	sessionId?: string;
}

interface ChromeStorageChange {
	oldValue?: unknown;
	newValue?: unknown;
}

interface ChromeStorageArea {
	get(keys: Record<string, unknown>): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

interface ChromeApi {
	tabs: {
		query(queryInfo: { windowId?: number }): Promise<ChromeTab[]>;
		get(tabId: number): Promise<ChromeTab>;
		create(createProperties: { url?: string; active?: boolean; windowId?: number }): Promise<ChromeTab>;
		remove(tabId: number): Promise<void>;
		update(tabId: number, updateProperties: { active?: boolean }): Promise<ChromeTab>;
		onCreated: ChromeEvent<(tab: ChromeTab) => void>;
		onUpdated: ChromeEvent<(tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTab) => void>;
		onRemoved: ChromeEvent<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void>;
		onDetached: ChromeEvent<(tabId: number, detachInfo: { oldWindowId: number; oldPosition: number }) => void>;
		onAttached: ChromeEvent<(tabId: number, attachInfo: { newWindowId: number; newPosition: number }) => void>;
		onActivated: ChromeEvent<(activeInfo: { tabId: number; windowId: number }) => void>;
	};
	windows: {
		WINDOW_ID_NONE: number;
		get(windowId: number): Promise<ChromeWindow>;
		create(createData: { url: string; focused: boolean; type: "normal" }): Promise<ChromeWindow | undefined>;
		onFocusChanged: ChromeEvent<(windowId: number) => void>;
		onRemoved: ChromeEvent<(windowId: number) => void>;
	};
	debugger: {
		attach(target: ChromeDebuggerSession, requiredVersion: string): Promise<void>;
		detach(target: ChromeDebuggerSession): Promise<void>;
		sendCommand(
			target: ChromeDebuggerSession,
			method: string,
			params?: Record<string, unknown>,
		): Promise<Record<string, unknown> | undefined>;
		onEvent: ChromeEvent<(source: ChromeDebuggerSession, method: string, params?: Record<string, unknown>) => void>;
		onDetach: ChromeEvent<(source: ChromeDebuggerSession, reason: string) => void>;
	};
	storage: {
		local: ChromeStorageArea;
		session: ChromeStorageArea;
		onChanged: ChromeEvent<(changes: Record<string, ChromeStorageChange>, areaName: string) => void>;
	};
	alarms: {
		create(name: string, alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void>;
		onAlarm: ChromeEvent<(alarm: { name: string }) => void>;
	};
	action: {
		setBadgeText(details: { text: string }): Promise<void>;
		setBadgeBackgroundColor(details: { color: string }): Promise<void>;
		onClicked: ChromeEvent<(tab: ChromeTab) => void>;
	};
	runtime: {
		getURL(path: string): string;
		openOptionsPage(): Promise<void>;
		onInstalled: ChromeEvent<() => void>;
		sendMessage(message: Record<string, unknown>): Promise<Record<string, unknown>>;
		onMessage: ChromeEvent<
			(
				message: unknown,
				sender: { url?: string },
				reply: (response: Record<string, unknown>) => void,
			) => boolean | void
		>;
		onStartup: ChromeEvent<() => void>;
	};
}

declare const chrome: ChromeApi;
