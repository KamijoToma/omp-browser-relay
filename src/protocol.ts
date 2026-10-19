/** Versioned transport between the standalone relay and its Chrome extension. */
export const RELAY_PROTOCOL_VERSION = 3;
export const DISCARDED_TABS_PROTOCOL_VERSION = 1;

export interface RelayCapabilities {
	protocolVersion: typeof RELAY_PROTOCOL_VERSION;
	windowIsolation: "dedicated-window";
	sharedControl: true;
	tabAdoption: "window-membership";
	nativeFocus: "browser-dependent";
}

export const RELAY_CAPABILITIES: RelayCapabilities = {
	protocolVersion: RELAY_PROTOCOL_VERSION,
	windowIsolation: "dedicated-window",
	sharedControl: true,
	tabAdoption: "window-membership",
	nativeFocus: "browser-dependent",
};

/** Only tabs inside the extension-owned workspace are exposed. */
export interface TabSnapshot {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	discarded: boolean;
	windowId: number;
}

export type RelayRpcRequest =
	| { op: "attach"; tabId: number }
	| { op: "detach"; tabId: number }
	| { op: "send"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { op: "createTab"; url: string }
	| { op: "removeTab"; tabId: number }
	/** Select a workspace tab without focusing its window. */
	| { op: "activateTab"; tabId: number };

export type RelayToExtMessage = ({ t: "rpc"; id: number } & RelayRpcRequest) | { t: "pong" };

export type ExtToRelayMessage =
	| {
			t: "hello";
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			discardedTabsProtocol: typeof DISCARDED_TABS_PROTOCOL_VERSION;
			browserSession: string;
			instanceId: string;
			userAgent: string;
			browserVersion: string;
			workspaceWindowId: number | null;
			tabs: TabSnapshot[];
			attachedTabIds: number[];
	  }
	| { t: "workspace"; windowId: number | null }
	| { t: "cdpEvent"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
	| { t: "tabCreated"; tab: TabSnapshot }
	| { t: "tabUpdated"; tab: TabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| { t: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
	| { t: "ping" };

/** Present on both ready (200) and waiting-for-extension (503) discovery replies. */
export interface RelayUnavailableInfo {
	error: string;
	extensionSeen: boolean;
	uptimeMs: number;
	ompRelay: RelayCapabilities;
}

/** Commands which must be able to release a blocked page command without waiting for its view lock. */
export function isWorkspaceCleanupCommand(method: string, params?: Record<string, unknown>): boolean {
	return (
		(method === "Emulation.setFocusEmulationEnabled" && params?.enabled === false) ||
		(method === "Page.handleJavaScriptDialog" && params?.accept === false) ||
		method === "Page.screencastFrameAck" ||
		method === "Page.stopScreencast" ||
		method === "Runtime.runIfWaitingForDebugger" ||
		method === "Target.detachFromTarget" ||
		method === "Fetch.continueRequest" ||
		method === "Fetch.continueResponse" ||
		method === "Fetch.fulfillRequest" ||
		method === "Fetch.failRequest" ||
		method === "Fetch.continueWithAuth"
	);
}
