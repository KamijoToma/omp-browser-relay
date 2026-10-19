# omp-browser-relay reference

This is the canonical reference shipped with the `omp-browser-relay` skill and served verbatim by `GET /docs`. The standalone relay transports stock Chrome DevTools Protocol (CDP) between an unmodified omp browser client and a Chrome extension. It does not supply `browser`, `BrowserTab`, or new JavaScript methods, and requires no additional MCP server.

## Resolve the configured service

Use the active omp profile's `browser.relayUrl` setting, or the relay URL explicitly supplied by the user/operator. There is no portable fixed port. Keep the standalone `omp-browser-relay serve --port <configured-port>` process running separately; configure the extension with that same port and, if used, the same extension token. The service listens on loopback only.

Configure the stock client with `omp config set browser.relayUrl <configured-base-url>`. Opt in with `PI_BROWSER_RELAY=1 omp`, the profile's `browser.relay` setting, or a per-open `app: { relay: true }`. The stock environment override takes precedence according to the client's configuration rules. Do not assume that upstream `omp browser-relay` starts this standalone package: it manages the upstream bundled implementation instead.

Use an HTTP client with the resolved base URL to discover:

- `GET /capabilities`: schema-versioned JSON with this package's actual version, private protocol contract (`ompRelay`), `/docs` location, backend support and current readiness, input semantics, and stock-client compatibility. Available before any extension connects. `backend.supported: true` means this relay implements CDP input; `backend.ready: false` means no compatible extension is currently ready. Neither means a particular stock frontend exposes every helper.
- `GET /docs`: this Markdown reference (`text/markdown`), independent of extension readiness.
- `GET /json/version`: stock CDP discovery, HTTP 200 when ready, or HTTP 503 with extension/reconnection diagnostics otherwise. The private extension/service protocol is version 3; stock client CDP remains unchanged.
- `GET /json/list`: pages currently eligible in the relay workspace, not arbitrary pages in the user's profile.

These endpoints add no cross-origin browser access. CDP WebSocket upgrades reject browser Origin headers. The optional `--token` authenticates only the extension connection, not CDP clients. Untrusted local native processes able to reach the port can control the signed-in workspace; do not expose the service as a public remote endpoint.

## Install the extension and optional skill

Use the packaged `omp-browser-relay install [--dir <destination>]` to copy the unpacked Chrome extension (default `~/.omp-browser-relay/extension`), then load that directory from Chrome's extensions page in Developer mode.

Separately opt in with `omp-browser-relay install-skill [--dir <destination>]`. The default destination is `~/.agents/skills/omp-browser-relay`. A custom destination is the skill directory itself, containing `SKILL.md` and this sibling `reference.md`. Extension installation does not install a skill. The installed files need no repository checkout, and a packaged CLI keeps its extension and skill assets alongside its bundle.

## Stock client compatibility

Version 0.2.0 was exercised with the real, unmodified stock omp browser JavaScript frontend and SDK host: source and npm **18.12.2**, plus npm **18.4.2**, on Chrome 150.0.7871.24/Linux X11. Both the convenience `tab.drag` and custom mouse trajectories produced checked Canvas pixels; screenshot and lifecycle probes also passed. This is shared-control and API-compatibility acceptance, not a promise of native focus isolation. Check the installed client's own browser documentation for exact signatures and any newer version's behavior.

| Stock omp | Relay-page behavior |
| --- | --- |
| 18.12.2 | An ordinary `browser.open()` can create a new owned business page in the dedicated workspace. `browser.targets({ app: { relay: true } })` is available. Owned and adopted/borrowed pages have distinct lifecycle semantics. |
| 18.4.2 | Opening adopts existing eligible business pages only. If none exist, use the extension's work-tab creation action first. No `browser.targets()` helper or owned relay-page creation/close semantics. |

Both versions provide ordinary browser interaction helpers, including explicit mouse move/down/up operations used for captured canvas paths. The stock `tab.drag(from, to)` accepts CSS selectors or `{ x, y }` viewport points; it is a convenience drag, not a programmable trajectory or a CAPTCHA solver. A legacy frontend cannot gain absent APIs from a backend capability advertisement.

An explicit `app.target` uses the stock client's URL/title substring matcher; do not pass opaque CDP target IDs. Inspect available targets first when the client's discovery helper exists. Adopting with `url` can navigate the adopted real page; do so only with authorization. Closing a borrowed handle releases it without promising to close the actual page. Follow the installed client's owned-page lifecycle rules rather than assuming all closes destroy pages.

Example in stock omp's JavaScript Eval environment (not a standalone Node script):

```javascript
const tab = await browser.open({
  name: "relay-work",
  app: { relay: true },
  url: "https://example.com"
});
await tab.observe();
```

On 18.4.2 this adopts and navigates a pre-existing workspace page; create that page first. `browser.tab(name)` only looks up a previously opened handle. Use selectors/observations from the actual page instead of guessing elements.

## Dedicated workspace, shared control

The relay exposes only business tabs in an extension-owned normal browser window. Initial creation opens that window unfocused at the requested business URL; later creations and selections stay within the workspace. There is no reserved guard page or special workspace URL. Tab selection itself does not request native window activation, but Chrome's trusted mouse-input path can activate the receiving window.

Membership is the adoption boundary: a user tab moved **into** the workspace is adopted and can be driven; moving a tab **out** revokes access and detaches relay debugging. Closing the window retires its identity and targets; a later create can provision a fresh workspace. Discarded tabs and browser-run identity markers remain part of discovery, so a listed discarded page is not necessarily attached/live and stale identities must not be reused.

User focus of the workspace does **not** pause the agent. This is shared control, not an exclusive lease: the user can switch or interact with business tabs, and agent operations may also select tabs within that same window. Coordinate changes to avoid conflicting edits. Multiple client connections share the debugger transport; the relay does not arbitrate application-level intent.

Actual focus emulation stays disabled on owned pages, including when a client requests focus emulation. Runtime promises release the view-preparation lock after dispatch, so an awaited script does not monopolize other pages' preparation; ownership cancellation still applies when tabs/windows disappear or move.

**Native activation policy:** this real-page shared-control mode permits Chrome to activate its workspace during mouse input. Chrome 150.0.7871.24 did so in both isolated Linux/X11 and KWin/Wayland runs. `boundaries.backgroundNativeFocusIsolation` reports `false`: typing or scrolling in another window may be interrupted. Use this policy only when that tradeoff is accepted; it does not provide uninterrupted background automation. The relay still rejects target discovery/control outside its workspace and does not restore another window's focus after activation. Do not confuse page authorization with native focus isolation or claim a headless run proves desktop behavior.

## Mouse, drag, and coordinate semantics

Use stock browser helpers. Input is delivered through the target page's CDP mouse/keyboard path, not OS pointer/keyboard injection and not `element.dispatchEvent(...)` or synthetic DOM clicking. The relay does not move the desktop cursor. Successful dispatch alone says nothing about the application's acceptance of an action.

Coordinates for `mouseMove`, `clickAt`, coordinate-based `drag`, and element boxes are **CSS pixels relative to the page viewport** (top-left origin). They are not device pixels, desktop coordinates, browser-window chrome coordinates, or full-page screenshot coordinates. Device scale factor, screenshot resizing, page zoom, and scroll offsets must be accounted for before using image-derived points. `tab.box(selector)` supplies a current viewport-relative box; remeasure after scrolling/layout changes. Use `scrollIntoView` when necessary. A missing or detached target is an error, not permission to act on another tab.

Simple selector drag:

```javascript
await tab.drag("#draggable", "#drop-zone");
```

Point-to-point drag (replace with measured on-screen points):

```javascript
const startBox = await tab.box("#draggable");
const endBox = await tab.box("#drop-zone");
if (!startBox || !endBox) throw new Error("Drag targets are not available");
await tab.drag(
  { x: startBox.x + startBox.width / 2, y: startBox.y + startBox.height / 2 },
  { x: endBox.x + endBox.width / 2, y: endBox.y + endBox.height / 2 }
);
```

For canvas drawing, a slider, or a custom trajectory, supply your own measured path. `mouseMove(x, y, { steps })` interpolates movement; it does not accept a path array, duration, or a human-behavior guarantee. `mouseDown`/`mouseUp` use the current page pointer and optionally `{ button: "left" }` (left is the default). Always release in `finally`, including when movement fails:

```javascript
const box = await tab.box("canvas");
if (!box) throw new Error("Canvas is not available");
const path = [
  { x: box.x + box.width * 0.15, y: box.y + box.height * 0.25 },
  { x: box.x + box.width * 0.45, y: box.y + box.height * 0.40 },
  { x: box.x + box.width * 0.80, y: box.y + box.height * 0.70 }
];
await tab.mouseMove(path[0].x, path[0].y);
try {
  await tab.mouseDown({ button: "left" });
  for (const point of path.slice(1)) {
    await tab.mouseMove(point.x, point.y, { steps: 8 });
  }
} finally {
  await tab.mouseUp({ button: "left" });
}
```

Do not blindly retry a failed drag: re-observe page state and ownership first. If a tab moves out or disconnects, release can itself fail; report the actual error and do not substitute another target or native input. Use ordinary keyboard helpers for page typing and modifier keys, releasing held keys in `finally` too.

## Screenshots, recording, errors, and exceptions

Use the stock `tab.screenshot(...)` and, where present, `tab.recordStart(path, options)` / `tab.recordStop()` helpers. They capture the real owned page through the existing client/CDP path, not an unrelated foreground page or fabricated image. Recording remains a stock-client feature with its codec/runtime prerequisites (for example ffmpeg and appropriate encoders); transport support is not proof the local client has the dependencies. Inspect actual returned media/page state for acceptance. Do not claim MP4 or a codec was verified just because another format worked.

A dedicated window is **not profile isolation**. Cookies, accounts, storage, service workers, network, and browser resources remain shared with the user's normal browsing. Actions may be attributed to the real signed-in user. Scope all work to the user's request.

Browser/system permissions, file/authentication dialogs, clipboard/native UI, debugger notifications, and pages/evaluated scripts requesting focus or opening windows remain exceptions outside the background focus contract. There is no unconditional focus guarantee or automatic foreground-recovery promise. Browser-global window commands, profile-wide permission overrides, and download behavior configuration are restricted/rejected rather than silently affecting unrelated windows. Another debugger/DevTools attachment, restricted Chrome pages, discarded/removed tabs, or extension disconnection can make an operation fail. Preserve real errors; do not synthesize success or weaken scope to work around them.

CAPTCHA recognition, challenge scoring, and acceptance are controlled by the site. Even a correctly delivered captured pointer trajectory is **not a guarantee of passing a real CAPTCHA**. Do not present a canvas demonstration, scripted fixture, or successful mouse dispatch as evidence of real challenge acceptance. Request user help when appropriate.
