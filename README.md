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

Start this project's service **before** opening omp. A separate port avoids a previously started stock relay:

```sh
omp-browser-relay serve --port 9333
```

Open the extension options and save port `9333`. If you start the service with `--token`, save the same token there. Configure the stock client, without changing any omp code:

```sh
omp config set browser.relayUrl http://127.0.0.1:9333
PI_BROWSER_RELAY=1 omp
```

Alternatively, opt in per call with `browser.open({ app: { relay: true }, url: "https://example.com" })`, or set `browser.relay` to `true` for the profile. `PI_BROWSER_RELAY` remains the stock client's override.

**The original omp auto-starter does not launch this executable.** Keep the standalone service running yourself, or use your service supervisor. `omp browser-relay` and `omp browser-relay install` still exist upstream and manage its bundled implementation; they are not this project's serve/install commands. No upstream installation files are replaced.

In omp 18.12.2, ordinary `browser.open()` creates a new work page in the dedicated window. Version 18.4.2 only adopts existing pages: first click **Create background work tab** in this extension's options. That button creates a blank workspace page. Old clients also lack `browser.targets()` and owned relay-page creation/close semantics; the extension cannot add missing frontend APIs. An explicit `app.target` uses the client's URL/title matcher, not a CDP target id.

## Discover capabilities and install the skill

```sh
omp-browser-relay install-skill
```

This opt-in command installs `SKILL.md` and its portable `reference.md` to `~/.agents/skills/omp-browser-relay`; `--dir <directory>` selects a different skill directory. Extension installation does not silently install agent instructions. The unmodified omp skill loader can discover the installed skill; no new browser JavaScript facade or MCP server is added.

At the **configured relay URL**, `GET /capabilities` returns versioned support/readiness, input semantics, current limitations and a documentation location. `GET /docs` serves the same canonical Markdown reference bundled with the skill, even without an extension connection. Backend readiness is not proof of native-focus isolation.

The guide documents the existing `tab.drag`, `tab.mouseMove`, `tab.mouseDown` and `tab.mouseUp` APIs, viewport-CSS coordinates, custom trajectories, release in `finally`, compatibility and real-error handling. It does not advertise a CAPTCHA solver or invent APIs absent from older clients.

When upgrading from 0.1, update both the service and extension, reload it in Chrome, and close any old reserved workspace tab. New workspaces have no reserved page.


## Window and input contract

- First work-page creation opens a separate, unfocused normal window at the requested business URL. Subsequent pages stay in that window.
- Window membership is the authorization boundary. Moving a business tab in grants access; moving it out revokes subsequent control and releases relay debugging. Page state is preserved during the move.
- Business pages remain selected for input and capture. There is no static guard tab, hidden-page focus-emulation loop, or private 1-pixel recording.
- User focus does not pause automation. Users and agents can interact with the same workspace; clicks, input, navigation and selection within it can conflict.
- Input uses the page's real CDP mouse/keyboard path, not OS input injection or synthetic DOM clicks. Actual focus emulation remains disabled, including when stock clients request it.
- The service does not directly activate a native window or restore focus after an activation. **Chrome can nevertheless activate the window during ordinary trusted mouse input**; this is permitted by the shared-control policy and disclosed in the skill and capability response.
- Captures return the actual business page and do not restore another tab after completion. A user's intervening selection is not undone by a late screenshot.
- Closing a workspace invalidates its targets. Closing its last business tab can retire the window before the close RPC is acknowledged; the successful removal acknowledgement is preserved.
- Workspace identity and attachments persist in Chrome session storage, not window titles. Browser-run identity protects against stale target IDs after browser restart.
- Discarded pages remain listed but are not attached as live pages until revived. Awaited JavaScript releases the preparation lock; removal, migration, disconnect and explicit detach still cancel pending work.

The relay multiplexes multiple Puppeteer connections and flat child sessions over one debugger attachment per tab. Stock CDP discovery and discarded-tab markers remain unchanged. Private protocol **3** removes pause messages and describes shared control and window-membership adoption; old extension/service pairs must be updated together. `ompRelayVersion` identifies this project, not a fabricated omp release.

## Boundaries

This is **target authorization, not browser-profile isolation or a verified native-focus sandbox**. Cookies, same-origin storage, accounts, service workers, CPU and network remain shared. CAPTCHA recognition/acceptance is site-dependent; a Canvas pointer demonstration is not a real challenge's acceptance.

Browser/system permissions, native file/authentication dialogs, and sites or evaluated JavaScript that actively request windows or focus are **not sandboxed** by the relay. There is no unconditional focus guarantee for those flows, and no automatic foreground-recovery path. Global browser/window commands, profile-wide permission overrides, and download behavior configuration are rejected. Clipboard and native UI workflows are outside the background-isolation contract. Chrome may show its own debugger notification, and a tab with another debugger/DevTools attached cannot be driven.

The HTTP/WebSocket server binds loopback and rejects web-origin CDP clients. **Local native processes that can reach the CDP port can control the workspace in the signed-in profile.** `--token` authenticates the extension connection only; it does not authenticate CDP clients or protect against untrusted local processes.

Moving a page out revokes future relay commands; already-dispatched JavaScript, timers or network requests cannot be rolled back. Stock clients own retry/cleanup bookkeeping and disconnect wording. Chrome-restricted pages and other debugger attachments can make access fail; the relay does not substitute another page or synthesize success.

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

Version 0.2.0 passed these headed acceptance runs on Chrome 150.0.7871.24/Linux X11 with unmodified source 18.12.2 at `9d5d4ac5b50ac2bb5866e4202efc0cf785dfc57a`, npm 18.12.2 and npm 18.4.2. Checks include both `tab.drag` and custom captured mouse paths, forms, decoded screenshot/display pixels, diffs/revisions, real errors and owned/borrowed lifecycle. The 18.12.2 runs also decoded VP9 WebM after explicit stop and owned/borrowed close. Recording probes require `ffmpeg`/`ffprobe`; MP4 additionally needs libx264 and was not verified.

`RELAY_SMOKE_SCREENSHOT=/path/result.png` saves the native capture. `RELAY_SMOKE_CLIENT=/path/client-probe.mjs` runs another Bun client against the temporary relay and fixture origin.

Headless runs (`RELAY_SMOKE_HEADLESS=1`) are functional diagnostics, not desktop input proof. Native acceptance concerns real user operation in the shared workspace and authorization of targets outside it; native activation itself is allowed. Browser profiles and display-server instances used for smoke are disposable, and the original omp checkout is read-only to the client fixtures.

## Project history

Extracted from oh-my-pi's browser-relay extension and CDP bridge. The MIT attribution and pre-extraction changelog history are preserved. Source, build, CLI, protocol, extension, and tests in this checkout do not import the omp repository.
