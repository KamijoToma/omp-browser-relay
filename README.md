# omp-browser-relay

Standalone Bun CDP relay and Chrome MV3 extension for driving a **dedicated agent window** in your existing browser profile. Your normal browser windows are not discovered, attached, or adopted.

The Chrome extension is named **OMP Browser Relay (Background Fork)**, with the short name **OMP Relay BG** and maintainer **KamijoToma**. Its homepage is [this independent repository](https://github.com/KamijoToma/omp-browser-relay), not the upstream omp site. The toolbar tooltip, settings page, and reserved workspace tab carry the fork identity; CLI names, permissions, and relay protocol are unchanged.

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

In omp 18.12.2, ordinary `browser.open()` creates a new work page in the dedicated window. Version 18.4.2 only adopts existing pages: first click **Create background work tab** in this extension's options. That button creates a blank work page without switching windows. Old clients also lack `browser.targets()` and owned relay-page creation/close semantics; the extension cannot add missing frontend APIs. An explicit `app.target` uses the client's URL/title matcher, not a CDP target id.

## Window and input contract

- Work-page creation by a current client or the options button creates a separate, unfocused agent window if absent. Existing targets are restricted to that workspace; ordinary user tabs are never adopted. Legacy opens only adopt pages, as described above.
- A reserved **OMP Relay BG — Agent Workspace** tab supplies a safe native view. It is not an automation target. Work pages are created inactive and may be selected within the agent window without focusing the window.
- Ordinary input uses the target page's real CDP keyboard/mouse events, not OS keyboard/mouse automation or synthetic DOM clicks. Work pages remain inactive during input; page-level focus emulation keeps background interaction responsive. A private, acknowledged 1-pixel screencast keeps captured pointer gestures drawing, then stops on release; its frames are never sent to clients or mixed into their recordings.
- A screenshot temporarily selects its own work page with focus emulation disabled, captures the actual page, and restores the background interaction view. It never raises the window or falls back to a screenshot of the user's visible page.
- Selecting the agent window pauses automation. Leaving it permits control again. In-flight/queued work cannot change the user's native selection after takeover.
- Moving a work tab into another window revokes access and removes its relay debugger attachment. Closing the workspace invalidates its targets; a later work-page creation can create a fresh dedicated window.
- Detach, extension disconnect, and controller focus-lease release clear relay-owned focus emulation. Workspace and reserved-tab identity are stored in Chrome session storage, not inferred from window titles or matching URLs. Browser-run identity prevents a stale target id from naming a reused Chrome tab id after restart.
- Discarded work pages remain listed but are not announced or auto-attached as live CDP pages. Native selection can revive them without raising the window.
- Awaited JavaScript does not hold the native-view preparation lock, so selector cancellation and other pages' operations can finish. Native view transitions and captures remain serialized; takeover still cancels pending work.

The relay multiplexes multiple Puppeteer connections over one debugger attachment per work tab, including flat child sessions for cross-origin frames. Stock CDP discovery and discarded-tab capability markers are preserved. `ompRelayVersion` identifies this independent implementation, not a fabricated omp release. Protocol 2 and `ompRelay: { protocolVersion: 2, windowIsolation: "dedicated-window" }` describe the private extension/service pair; stock clients do not need a patch or custom capability check.

## Boundaries

This is **focus/target isolation, not browser-profile isolation**. Cookies, same-origin storage, accounts, service workers, CPU, and network resources remain shared with the user's profile. CAPTCHA recognition/acceptance, including trajectory-based challenges, is site-dependent; delivering real pointer events does not guarantee success.

Browser/system permissions, native file/authentication dialogs, and sites or evaluated JavaScript that actively request windows or focus are **not sandboxed** by the relay. There is no unconditional focus guarantee for those flows, and no automatic foreground-recovery path. Global browser/window commands, profile-wide permission overrides, and download behavior configuration are rejected. Clipboard and native UI workflows are outside the background-isolation contract. Chrome may show its own debugger notification, and a tab with another debugger/DevTools attached cannot be driven.

The HTTP/WebSocket server binds loopback and rejects web-origin CDP clients. **Local native processes that can reach the CDP port can control the workspace in the signed-in profile.** `--token` authenticates the extension connection only; it does not authenticate CDP clients or protect against untrusted local processes.

While the user focuses the agent window, tab creation, activation, and removal are refused too. The unmodified client owns its cleanup/retry bookkeeping: the extension cannot promise that a refused close is retained for retry or automatically reaped later. Leave the workspace and close it explicitly if needed. Likewise, the stock client's disconnect/version error wording and reconnect policy are not replaced by this plugin.

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

This needs `Xvfb`, `openbox`, and `xdotool`. Native mode delivers XTEST keyboard input and mouse-wheel scrolling to the **currently focused** user window while the agent holds its canvas pointer capture in another window; it checks actual scrolling, complete input values, rendered canvas pixels, native focus, and Chrome focus-event history. It also exercises screenshots, tab selection, takeover/resume, migration, workspace replacement, and the supervisor/worker two-connection pattern. CI runs this headed smoke.

For untouched-client acceptance, use the same native-display environment with:

```sh
bun run smoke:upstream
RELAY_UPSTREAM_SOURCE=/path/to/oh-my-pi bun run smoke:upstream
RELAY_SMOKE_CLIENT=scripts/legacy-client.ts bun scripts/smoke.ts
```

The first command installs exact npm 18.12.2 in a temporary fixture; the second links the source checkout read-only; the third installs exact npm 18.4.2. Fixtures do not add omp to this project's runtime dependencies. Each runs that version's real browser JavaScript facade and `createBrowserPrelude` SDK host, including serialized function arguments, not a replacement low-level client. CLI identity is checked with `--version`; no LLM-driven interactive CLI session is claimed.

Source 18.12.2 at `9d5d4ac5b50ac2bb5866e4202efc0cf785dfc57a` and both npm releases passed on Chrome 150.0.7871.24/Linux X11. Checks include default open/adoption, named-page isolation, forms, captured canvas gestures, decoded screenshot/display pixels, exact screenshot diffs and change revisions, real errors, and owned/borrowed lifecycle semantics. The 18.12.2 runs also decode actual VP9 WebM recordings and verify both rendered color states after stop and owned/borrowed close. These recording probes need system `ffmpeg` and `ffprobe` with VP9 or VP8; MP4 additionally needs the original client's libx264 prerequisite and is not part of this proof.

`RELAY_SMOKE_SCREENSHOT=/path/result.png` saves the native capture. `RELAY_SMOKE_CLIENT=/path/client-probe.mjs` runs another Bun client against the temporary relay and fixture origin.

Headless runs (`RELAY_SMOKE_HEADLESS=1`) are useful diagnostics, but are not evidence about desktop input focus. Native verification has been exercised on Linux/X11; other operating systems still require their own headed acceptance run.

## Project history

Extracted from oh-my-pi's browser-relay extension and CDP bridge. The MIT attribution and pre-extraction changelog history are preserved. Source, build, CLI, protocol, extension, and tests in this checkout do not import the omp repository.
