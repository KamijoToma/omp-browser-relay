# omp-browser-relay

Standalone Bun CDP relay and Chrome MV3 extension for a **dedicated shared-control workspace window** in your existing browser profile. Tabs outside that window are not discovered, attached, or adopted.

> **Focus policy:** this version uses real, visible business pages and permits Chrome to activate the workspace during mouse input. Typing or scrolling in another window may be interrupted. `/capabilities` reports `backgroundNativeFocusIsolation: false`; the isolation boundary is which tabs can be controlled, not which native window stays in the foreground.

The Chrome extension is named **OMP Browser Relay (Background Fork)**, with the short name **OMP Relay BG** and maintainer **KamijoToma**. Its homepage is [this independent repository](https://github.com/KamijoToma/omp-browser-relay), not the upstream omp site. Toolbar and settings-page branding distinguish the fork; CLI names and permissions remain independent of the private extension/service protocol.

## Requirements

- Bun 1.3.14 or newer.
- Chrome/Chromium 125 or newer, or a compatible Chromium-based browser with `chrome.debugger` support.
- `zip` for building the extension archive. The installed CLI has no npm runtime dependencies.
- Unmodified omp. The current source checkout and npm release 18.12.2, plus npm 18.4.2 with pre-existing work pages, have been exercised.

## Install from this checkout

```sh
bun install --frozen-lockfile
bun run build
bun link
omp-browser-relay install
```

Ensure Bun's global bin directory is on `PATH`. The installer copies the built extension to `~/.omp-browser-relay/extension`; use `--dir <path>` to choose another directory. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the installed directory. A packaged extension is also built at `dist/omp-browser-relay-extension.zip`.

## Connect unmodified omp

Start this project's service **before** opening omp. A separate port avoids a previously started stock relay. By default, the service binds to `127.0.0.1`:

```sh
omp-browser-relay serve --port 9333
```

For remote TUI access over Tailscale, enable **Tailscale access** in the extension options page. The toggle live-rebinds the relay's single listening socket without restarting the relay process. The local extension briefly reconnects after each change and continues to connect to `127.0.0.1`; it does not connect through the remote Tailscale address. The options page shows detected Tailscale addresses and offers a copyable command for configuring a remote TUI:

```sh
omp config set browser.relayUrl http://<computer-tailnet-ip>:<port>
```

When enabled, the relay rebinds its single listener on the same port to wildcard (`0.0.0.0`). Changing access replaces the listening socket and disconnects active CDP clients; the local extension briefly reconnects. Application-level source filtering accepts remote CDP connections only from Tailnet IPv4 addresses in `100.64.0.0/10`; that shared address range is not a device identity. `/ext` remains loopback-only. CDP clients are unauthenticated, so use Tailscale ACLs and host firewall rules to restrict peers. Do not expose the relay publicly.

The CLI `--host` option remains available for advanced deployments. `--host 0.0.0.0` starts with Tailnet access enabled and applies the same source filtering; use the extension toggle to change access at runtime. `--token` authenticates the browser extension connection only, not CDP clients.

Open the extension options on the computer running the relay and save its port. If you start the service with `--token`, save the same token there. Configure the local omp profile:

```sh
omp config set browser.relayUrl http://127.0.0.1:9333
PI_BROWSER_RELAY=1 omp
```

For a remote TUI, set its own omp profile's `browser.relayUrl` to the Tailscale address and port shown by the extension options page, using the command above.


Alternatively, opt in per call with `browser.open({ app: { relay: true }, url: "https://example.com" })`, or set `browser.relay` to `true` for the profile. `PI_BROWSER_RELAY` remains the stock client's override.

**The original omp auto-starter does not launch this executable.** Keep the standalone service running yourself, or use your service supervisor. `omp browser-relay` and `omp browser-relay install` still exist upstream and manage its bundled implementation; they are not this project's serve/install commands. No upstream installation files are replaced.

In omp 18.12.2, ordinary `browser.open()` creates a new work page in the dedicated window. Version 18.4.2 only adopts existing pages: first click **Create background work tab** in this extension's options. That button creates a blank workspace page. Old clients also lack `browser.targets()` and owned relay-page creation/close semantics; the extension cannot add missing frontend APIs. An explicit `app.target` uses the client's URL/title matcher, not a CDP target id.

### Stop navigation prompts from stealing focus (`--suppress-beforeunload`)

**Problem.** When automation navigates or reloads a page that registered a `beforeunload` handler (editors, forms with unsaved changes), Chrome raises its "Leave site?" prompt. Chrome has to bring the tab and its window to the foreground to show that prompt, so it can un-minimize the workspace and take native focus; the client's automatic acceptance of the dialog only happens afterwards. The relay cannot stop that activation once the prompt exists.

**What the flag does.** `--suppress-beforeunload` makes the relay register a small page script (`Page.addScriptToEvaluateOnNewDocument`) on every tab it attaches. The script discards `beforeunload` listeners and neutralizes `window.onbeforeunload`, so the prompt is never raised and nothing is activated. The script is registered before the tab is advertised as attached, so no client command can navigate first; if registration fails it is logged (without URLs or page text) and the tab still attaches.

```sh
omp-browser-relay serve --port 9333 --suppress-beforeunload
```

Under launchd, add it to the job's `ProgramArguments`, then reload the job. `launchctl kickstart` reuses the already-loaded definition, so use `bootout` and `bootstrap` for the change to take effect:

```xml
<array>
	<string>/path/to/bun</string>
	<string>/path/to/omp-browser-relay/dist/cli.js</string>
	<string>serve</string>
	<string>--port</string>
	<string>9333</string>
	<string>--suppress-beforeunload</string>
</array>
```

```sh
launchctl bootout gui/$(id -u)/<label>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
```

**Verify.** `GET /capabilities` reports `pageIntervention.suppressBeforeUnload` (`true` when enabled). It is a page-behavior switch only: `boundaries.backgroundNativeFocusIsolation` stays `false`, and mouse input, page-initiated window/focus requests and native dialogs can still activate the window.

**Trade-offs and limits.**

- Off by default, because it also removes unsaved-changes warnings for people using the workspace window: closing a tab with an unsaved form no longer asks first.
- It applies to documents created after a tab is attached. Handlers a page registered earlier survive until its next navigation, so reload long-open pages once after (re)starting the relay.
- An inline `<body onbeforeunload>` attribute is not intercepted.
- Only the CLI flag controls it; the extension does not need reloading or reconfiguring.

## Discover capabilities and install the skill

```sh
omp-browser-relay install-skill
```

This opt-in command installs `SKILL.md` and its portable `reference.md` to `~/.agents/skills/omp-browser-relay`; `--dir <directory>` selects a different skill directory. Extension installation does not silently install agent instructions. The unmodified omp skill loader can discover the installed skill; no new browser JavaScript facade or MCP server is added.

At the **configured relay URL**, `GET /capabilities` returns versioned support/readiness, input semantics, current limitations and a documentation location. `GET /docs` serves the same canonical Markdown reference bundled with the skill, even without an extension connection. Backend readiness is not proof of native-focus isolation.

The guide documents the existing `tab.drag`, `tab.mouseMove`, `tab.mouseDown` and `tab.mouseUp` APIs, viewport-CSS coordinates, custom trajectories, release in `finally`, compatibility and real-error handling. It does not advertise a CAPTCHA solver or invent APIs absent from older clients.

For component controls and repeated forms, the same reference covers explicit label/control associations, scoped record edits, DOM postconditions, and reconciliation of completed, uncertain, and remaining work after a partial failure. The recipes use stock APIs, not framework-specific fallbacks or a new interaction facade. Minimum-disclosure guidance does not provide automatic screenshot, HAR, or tool-output redaction.

When upgrading from 0.1, update both the service and extension, reload it in Chrome, and close any old reserved workspace tab. New workspaces have no reserved page.


## Window and input contract

- First work-page creation opens a separate, unfocused normal window at the requested business URL. Subsequent pages stay in that window.
- Window membership is the authorization boundary. Moving a business tab in grants access; moving it out revokes subsequent control and releases relay debugging. Page state is preserved during the move.
- Business pages remain selected for input and capture. There is no static guard tab, hidden-page focus-emulation loop, or private 1-pixel recording.
- User focus does not pause automation. Users and agents can interact with the same workspace; clicks, input, navigation and selection within it can conflict.
- Input uses the page's real CDP mouse/keyboard path, not OS input injection or synthetic DOM clicks. Actual focus emulation remains disabled, including when stock clients request it.
- The service does not directly activate a native window or restore focus after an activation. **Chrome can nevertheless activate the window during ordinary trusted mouse input**; this is permitted by the shared-control policy and disclosed in the skill and capability response.
- Navigating away from a page that registered a `beforeunload` handler raises Chrome's "Leave site?" prompt, which also activates the window. The opt-in `--suppress-beforeunload` flag prevents that; see [Stop navigation prompts from stealing focus](#stop-navigation-prompts-from-stealing-focus---suppress-beforeunload).
- Captures return the actual business page and do not restore another tab after completion. A user's intervening selection is not undone by a late screenshot.
- Closing a workspace invalidates its targets. Closing its last business tab can retire the window before the close RPC is acknowledged; the successful removal acknowledgement is preserved.
- Workspace identity and attachments persist in Chrome session storage, not window titles. Browser-run identity protects against stale target IDs after browser restart.
- Discarded pages remain listed but are not attached as live pages until revived. Awaited JavaScript releases the preparation lock; removal, migration, disconnect and explicit detach still cancel pending work.

The relay multiplexes multiple Puppeteer connections and flat child sessions over one debugger attachment per tab. Stock CDP discovery and discarded-tab markers remain unchanged. Private protocol **3** removes pause messages and describes shared control and window-membership adoption; old extension/service pairs must be updated together. `ompRelayVersion` identifies this project, not a fabricated omp release.

## Boundaries

This is **target authorization, not browser-profile isolation or a verified native-focus sandbox**. Cookies, same-origin storage, accounts, service workers, CPU and network remain shared. CAPTCHA recognition/acceptance is site-dependent; a Canvas pointer demonstration is not a real challenge's acceptance.

Browser/system permissions, native file/authentication dialogs, and sites or evaluated JavaScript that actively request windows or focus are **not sandboxed** by the relay. There is no unconditional focus guarantee for those flows, and no automatic foreground-recovery path. Global browser/window commands, profile-wide permission overrides, and download behavior configuration are rejected. Clipboard and native UI workflows are outside the background-isolation contract. Chrome may show its own debugger notification, and a tab with another debugger/DevTools attached cannot be driven.

- The HTTP/WebSocket server binds to `127.0.0.1` by default and rejects web-origin CDP clients. The extension-page Tailnet access toggle live-rebinds the single listening socket on the same port without restarting the relay process. Changing access replaces the socket, disconnects active CDP clients, and briefly reconnects the local extension. Application-level source filtering accepts remote CDP only from Tailnet IPv4 `100.64.0.0/10`, while `/ext` remains loopback-only. This CGNAT range is not a device identity; Tailscale ACLs and host firewall rules should restrict peers. The CLI `--host 0.0.0.0` starts with Tailnet access enabled and uses the same source filter. Never expose the relay publicly. **CDP clients are not authenticated.** `--token` authenticates the extension connection only, not CDP clients.

Moving a page out revokes future relay commands; already-dispatched JavaScript, timers or network requests cannot be rolled back. Stock clients own retry/cleanup bookkeeping and disconnect wording. Chrome-restricted pages and other debugger attachments can make access fail; the relay does not substitute another page or synthesize success.

## Release privacy

- Local agent/session state (`.mesh/`) and `.env` files are ignored by Git; `.env.example` must contain placeholders only. Ignore rules do not remove files or identities already recorded in Git history.
- npm uses the `package.json` file allowlist. `prepack` rebuilds `dist/` from scratch; bundles omit source maps and the extension ZIP omits Unix owner/group metadata. Do not add browser profiles, captures, logs, or credentials to the allowlisted directories.
- Before publishing Git refs, review author/committer names and email addresses as well as file contents. Use a privacy-safe Git identity for new commits; changing existing commit identities requires an explicit history rewrite.
- Before release, run `bun run build` and `npm pack --dry-run --ignore-scripts` and inspect the listed files and extension ZIP, not just the working tree.

## Development and verification

```sh
bun run fmt
bun run check
bun test test
bun run build
```

The real-browser smoke installs the built extension into a disposable Chrome profile. On Linux, use an isolated X11 display and window manager rather than your daily desktop:

```sh
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome \
RELAY_SMOKE_NATIVE_INPUT=1 \
RELAY_SMOKE_WINDOW_MANAGER=openbox \
xvfb-run -a --server-args="-screen 0 1600x1000x24 -nolisten tcp" bun run smoke
```

This needs `Xvfb`, `openbox`, and `xdotool`. The native smoke explicitly permits workspace activation, verifies that outside pages are neither exposed nor mutated, checks captured Canvas drawing and mid-drag screenshots, and delivers actual XTEST keyboard, button and wheel interaction to the focused workspace while agent evaluation/screenshots continue. It also exercises move-in/out, two-client multiplexing, last-tab closure and replacement. It does not require native focus to stay on another window; that earlier guarantee is intentionally absent from this shared-control policy.

For untouched-client acceptance, use the same native-display environment with:

```sh
bun run smoke:upstream
RELAY_UPSTREAM_SOURCE=/path/to/oh-my-pi bun run smoke:upstream
RELAY_SMOKE_CLIENT=scripts/legacy-client.ts bun scripts/smoke.ts
```

The first command installs exact npm 18.12.2 in a temporary fixture; the second links the source checkout read-only; the third installs exact npm 18.4.2. Fixtures do not add omp to this project's runtime dependencies. Each runs that version's real browser JavaScript facade and `createBrowserPrelude` SDK host, including serialized function arguments, not a replacement low-level client. CLI identity is checked with `--version`; no LLM-driven interactive CLI session is claimed.

The original-client drivers also exercise a separate framework-free `/interaction` fixture: label activation of a non-hit-testable checkbox, scoped Save with sibling isolation, delayed DOM confirmation, and a real later API failure followed by observed continuation without repeating earlier side effects. These are browser API contracts, not evidence that an LLM follows the skill or that arbitrary websites are compatible.

Version 0.2.0 passed these headed acceptance runs on Chrome 150.0.7871.24/Linux X11 with unmodified source 18.12.2 at `9d5d4ac5b50ac2bb5866e4202efc0cf785dfc57a`, npm 18.12.2 and npm 18.4.2. Checks include both `tab.drag` and custom captured mouse paths, forms, decoded screenshot/display pixels, diffs/revisions, real errors and owned/borrowed lifecycle. The 18.12.2 runs also decoded VP9 WebM after explicit stop and owned/borrowed close. Recording probes require `ffmpeg`/`ffprobe`; MP4 additionally needs libx264 and was not verified.

The generic interaction contract additionally passed headless functional acceptance on Chrome 158.0.8106.0/macOS arm64 with the original npm 18.12.2 and 18.4.2 clients. The modern run also decoded the explicit-stop, owned-close, and borrowed-close VP9 recordings and verified their real frame/color content. This is not a new headed native-focus or LLM skill-compliance claim.

`RELAY_SMOKE_SCREENSHOT=/path/result.png` saves the native capture. `RELAY_SMOKE_CLIENT=/path/client-probe.mjs` runs another Bun client against the temporary relay and fixture origin.

Headless runs (`RELAY_SMOKE_HEADLESS=1`) are functional diagnostics, not desktop input proof. Native acceptance concerns real user operation in the shared workspace and authorization of targets outside it; native activation itself is allowed. Browser profiles and display-server instances used for smoke are disposable, and the original omp checkout is read-only to the client fixtures.

## Project history

Extracted from oh-my-pi's browser-relay extension and CDP bridge. The MIT attribution and pre-extraction changelog history are preserved. Source, build, CLI, protocol, extension, and tests in this checkout do not import the omp repository.
