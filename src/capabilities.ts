import { version } from "../package.json";
import reference from "../skills/omp-browser-relay/reference.md" with { type: "text" };
import { RELAY_CAPABILITIES } from "./protocol";

/** The installed skill and HTTP discovery serve this same canonical reference. */
export const RELAY_REFERENCE = reference;

export function relayCapabilities(ready: boolean, extensionSeen: boolean) {
	return {
		schemaVersion: 1,
		package: { name: "omp-browser-relay", version },
		docs: { path: "/docs", mediaType: "text/markdown" },
		ompRelay: RELAY_CAPABILITIES,
		backend: { supported: true, transport: "cdp", ready, extensionSeen },
		input: {
			delivery: "cdp-mouse-and-keyboard",
			coordinates: "viewport-css-pixels",
			pointer: ["move", "down", "up", "wheel", "drag"],
			customTrajectories: true,
			osInput: false,
			syntheticDomEvents: false,
		},
		stockClient: {
			apiProvider: "stock-omp-not-the-relay",
			verifiedVersions: ["18.4.2", "18.12.2"],
			compatibility: {
				"18.4.2": { existingPagesRequired: true, targetDiscovery: false, ownedPageLifecycle: false },
				"18.12.2": { existingPagesRequired: false, targetDiscovery: true, ownedPageLifecycle: true },
			},
		},
		boundaries: {
			profileIsolation: false,
			sharedControl: true,
			nativeFocus: "browser-dependent",
			backgroundNativeFocusIsolation: false,
			captchaPassGuaranteed: false,
			nativeIsolationVerification: "activation-observed-on-tested-chrome-150-x11-and-kwin-wayland",
		},
	};
}
