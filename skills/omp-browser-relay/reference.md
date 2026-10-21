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

Version 0.2.0 was exercised with the real, unmodified stock omp browser JavaScript frontend and SDK host: source and npm **18.12.2**, plus npm **18.4.2**, on Chrome 150.0.7871.24/Linux X11. Both the convenience `tab.drag` and custom mouse trajectories produced checked Canvas pixels; screenshot and lifecycle probes also passed. This is shared-control and API-compatibility acceptance, not a promise of native focus isolation or version coverage for every generic interaction recipe below. Check the installed client's own browser documentation for exact signatures and any newer version's behavior.

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

## Generic page interactions

Apply these five policies with the installed stock client's helpers; the relay adds no actionability, scoped-locator, transaction, or redaction API. The snippets use stock omp's JavaScript Eval with an already opened `tab`; `tab.run` callbacks receive `{ tab, page }`, where `page` is the stock runtime's Puppeteer page. Callback closures are not captured: keep needed data inside the callback or pass it through `args`.

Selectors below are **examples from the dev-only `/interaction` fixture**, not selectors to assume on a user's site or a route exposed by the relay service. Run these snippets in order on a fresh fixture page, after observing its relevant regions. On real pages derive selectors and expected states from the actual DOM/AX observation and the user's requested record. Prefer stable semantic attributes and explicit associations; do not depend on generated class names or a global first match.

### 1. Check actionability and explicit associations

Before input, identify exactly one intended target in the right region. Check visibility, enabled/read-only state, layout, and whether an overlay or `pointer-events` prevents the intended hit. Use read-only DOM inspection such as `getBoundingClientRect()`, computed styles, and `document.elementFromPoint()` when the observed target is not actionable; re-observe after scrolling or re-rendering. Do not make a hidden/disabled control clickable by mutating the page, guessing an ancestor, or dispatching synthetic events.

The fixture's `#label-control` checkbox has `pointer-events: none`; its visible `#associated-label` is a real HTML label. Verify `label.control` / `control.labels` before using the label's normal activation behavior:

```javascript
const associated = await tab.evaluate(() => {
  const control = document.querySelector("#label-control");
  const label = document.querySelector("#associated-label");
  return control instanceof HTMLInputElement &&
    label instanceof HTMLLabelElement &&
    label.control === control &&
    Array.from(control.labels ?? []).includes(label);
});
if (!associated ||
    (await tab.count("#label-control")) !== 1 ||
    (await tab.count("#associated-label")) !== 1 ||
    !(await tab.isEnabled("#label-control")) ||
    !(await tab.isVisible("#associated-label"))) {
  throw new Error("Inspect the control and its label before acting");
}
await tab.run(async ({ tab, page }) => {
  if (!(await tab.isChecked("#label-control"))) {
    await tab.click("#associated-label");
  }
  await page.waitForFunction(
    () => document.querySelector("#label-control")?.checked === true,
    { timeout: 5000 }
  );
});
```

A verified ARIA naming/ownership relationship can help identify the intended control, but does not make an arbitrary naming element a clickable activator. Where appropriate, focus the actual enabled control and use its ordinary keyboard semantics with stock `tab.focus` / `tab.press`; do not use keyboard input or a nearby wrapper to bypass a disabled control or workspace scope.

### 2. Scope repeated controls to one record or region

Identify the requested record using an observed, non-sensitive key or region before locating its field and action. Scope **both** reads and writes to that region; repeated labels such as Alias and Save are not globally unique. Revalidate the region after navigation/re-render, and stop if the record is ambiguous or absent rather than falling back to another row.

Both fixture rows contain `input[name="alias"]` and a Save button. This prepares only row B; the next recipe saves and verifies it:

```javascript
if ((await tab.count("#row-b")) !== 1 ||
    (await tab.count('#row-b input[name="alias"]')) !== 1 ||
    (await tab.count("#row-b button")) !== 1) {
  throw new Error("The intended row or its controls are not unique");
}
await tab.fill('#row-b input[name="alias"]', "row-b-only");
```

### 3. Define and wait for observable postconditions

Choose the required result **before** dispatch: checked/pressed state, the intended row's saved status, a persisted result, or another task-specific observation. A resolved click or fill confirms neither acceptance nor persistence. Wait for DOM predicates, not a framework's private `window` globals or a fixed delay. A timeout is an uncertain outcome to reconcile, not permission to submit again.

For this fresh fixture, saving the changed row B should produce Saved/count 1 while row A remains at its initial value, Unchanged/count 0. The predicate checks that contract without returning either field's value:

```javascript
await tab.run(async ({ tab, page }) => {
  await tab.click("#row-b button");
  await page.waitForFunction(() => {
    const a = document.querySelector('#row-a input[name="alias"]');
    return a instanceof HTMLInputElement && a.value === a.defaultValue &&
      document.querySelector("#row-a [data-save-state]")?.textContent === "Unchanged" &&
      document.querySelector("#row-a [data-save-count]")?.textContent === "0" &&
      document.querySelector("#row-b [data-save-state]")?.textContent === "Saved" &&
      document.querySelector("#row-b [data-save-count]")?.textContent === "1";
  }, { timeout: 5000 });
});
```

The fixture's visible status is its acceptance contract; it does not establish that an arbitrary site's backend persisted a change. Use the actual task's observable persistence evidence when that is required.

### 4. Preserve partial progress; reconcile before resuming

Keep batches small and record three disjoint groups: **completed** means the postcondition was verified; **uncertain** means an attempted action may have taken effect but was not verified; **remaining** means not attempted. Record the failed step too. A later rejection does not undo earlier actions, and a wait failure can occur after a successful side effect. Do not automatically replay an action, a submission, or the whole batch.

This fixture example deliberately tries a nonexistent selector for the third step. The first two buttons have real side effects; step two confirms completion asynchronously through its DOM `aria-pressed` state. A caught failure returns `status: "partial"`, never success:

```javascript
const outcome = await tab.run(async ({ tab, page }) => {
  const steps = [
    { id: "one", action: "#step-one", state: "#step-one" },
    { id: "two", action: "#step-two", state: "#step-two" },
    { id: "three", action: "#missing-step", state: "#step-three" }
  ];
  const completed = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    try {
      await tab.click(step.action);
      await page.waitForFunction(
        selector => document.querySelector(selector)?.getAttribute("aria-pressed") === "true",
        { timeout: 5000 }, step.state
      );
      completed.push(step.id);
    } catch (error) {
      return {
        status: "partial", completed, uncertain: [step.id],
        remaining: steps.slice(index + 1).map(item => item.id),
        failedStep: step.id,
        diagnostic: {
          name: typeof error?.name === "string" ? error.name : null,
          message: typeof error?.message === "string" ? error.message : String(error)
        }
      };
    }
  }
  return { status: "complete", completed, uncertain: [], remaining: [] };
});
const progressSummary = {
  status: outcome.status,
  completed: outcome.completed,
  uncertain: outcome.uncertain,
  remaining: outcome.remaining,
  failedStep: outcome.failedStep ?? null
};
console.log(JSON.stringify(progressSummary));
```

The caught error's name/message remain available in `outcome.diagnostic` for authorized diagnosis; the message may contain full URLs or submitted values. Keep it in the Eval session, separate from the completed-step ledger, and inspect or disclose it only as needed for the task. Routine output must use an explicit allowlist such as `progressSummary`, never dump the entire `outcome` or its diagnostic. This is disclosure discipline, not automatic redaction.

The progress object is application bookkeeping, **not** a stock exception contract, durable journal, transaction, rollback, or exactly-once guarantee. Callers must handle `partial` as unfinished work. If a `tab.run` call itself disconnects or times out, no returned ledger is guaranteed; re-observe all possibly attempted steps.

Before any explicit continuation, recheck page identity, workspace membership, authorization, and the affected records. Use actual state to move uncertain steps into completed or remaining; if the result cannot be established, stop and report uncertainty instead of guessing. On this fixture only, counts 1/1/0 with the first two buttons pressed establish that the third action is still unperformed. After reconciling that observation, resume only step three:

```javascript
const progress = await tab.evaluate(() => ["one", "two", "three"].map(name => ({
  done: document.querySelector(`#step-${name}`)?.getAttribute("aria-pressed") === "true",
  calls: Number(document.querySelector(`#step-${name}-count`)?.textContent)
})));
if (outcome.status !== "partial" || outcome.failedStep !== "three" ||
    !progress.every((step, index) =>
      step.calls === (index < 2 ? 1 : 0) && step.done === (index < 2))) {
  throw new Error("Reconcile the observed partial state before continuing");
}
await tab.run(async ({ tab, page }) => {
  await tab.click("#step-three");
  await page.waitForFunction(() => ["one", "two", "three"].every(name =>
    document.querySelector(`#step-${name}`)?.getAttribute("aria-pressed") === "true" &&
    document.querySelector(`#step-${name}-count`)?.textContent === "1"
  ), { timeout: 5000 });
});
```

The original outcome remains partial; report completion only after the resumed operation and the full requested postconditions have been verified. Never infer that a generic server-side action is safe to repeat merely because its visible UI did not change.

### 5. Minimize reads and disclosures

Read only the necessary region and return an explicit allowlist of task-relevant, non-sensitive fields. Prefer booleans, counts, and status categories to `value`, full-page text/HTML, URLs with query strings, request bodies, or raw errors. Password masking alone is insufficient: text/hidden fields, labels, and application state can also contain secrets. Keep credentials and submitted values out of progress ledgers and routine reports.

This report intentionally returns no alias or other form value:

```javascript
const report = await tab.evaluate(() => ({
  labelChecked: document.querySelector("#label-control")?.checked === true,
  rowBSaved: document.querySelector("#row-b [data-save-state]")?.textContent === "Saved",
  rowBSaveCount: Number(document.querySelector("#row-b [data-save-count]")?.textContent),
  stepsCompleted: ["one", "two", "three"].filter(name =>
    document.querySelector(`#step-${name}`)?.getAttribute("aria-pressed") === "true"
  ).length
}));
console.log(JSON.stringify(report));
```

Before screenshots or recordings, inspect the intended capture area for sensitive content and obtain any required disclosure authorization. Prefer a scoped capture when that suffices, such as `tab.screenshot({ selector: "#row-b [data-save-state]" })` for this synthetic fixture's status-only region; derive a safe region from actual observation on other pages. Do not assume recording supports the same region option. Avoid HAR/network capture unless needed and authorized. This is **operator guidance, not enforced global redaction**: the skill cannot sanitize every screenshot, recording, HAR, tool result, error, or model-context disclosure. An allowlisted report proves only what that report contains, not protection of other output paths.

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

Do not blindly retry any side-effectful action, including clicks, typing, submissions, or drags: re-observe page state and ownership, then reconcile [partial progress](#4-preserve-partial-progress-reconcile-before-resuming) before explicitly continuing. A rejected or timed-out call may already have changed the page. If a tab moves out or disconnects, release can itself fail; report the actual error and do not substitute another target or native input. Use ordinary keyboard helpers for page typing and modifier keys, releasing held keys in `finally` too.

## Screenshots, recording, errors, and exceptions

Use the stock `tab.screenshot(...)` and, where present, `tab.recordStart(path, options)` / `tab.recordStop()` helpers. They capture the real owned page through the existing client/CDP path, not an unrelated foreground page or fabricated image. Recording remains a stock-client feature with its codec/runtime prerequisites (for example ffmpeg and appropriate encoders); transport support is not proof the local client has the dependencies. Inspect actual returned media/page state for acceptance. Do not claim MP4 or a codec was verified just because another format worked.

A dedicated window is **not profile isolation**. Cookies, accounts, storage, service workers, network, and browser resources remain shared with the user's normal browsing. Actions may be attributed to the real signed-in user. Scope all work to the user's request.

Browser/system permissions, file/authentication dialogs, clipboard/native UI, debugger notifications, and pages/evaluated scripts requesting focus or opening windows remain exceptions outside the background focus contract. There is no unconditional focus guarantee or automatic foreground-recovery promise. Browser-global window commands, profile-wide permission overrides, and download behavior configuration are restricted/rejected rather than silently affecting unrelated windows. Another debugger/DevTools attachment, restricted Chrome pages, discarded/removed tabs, or extension disconnection can make an operation fail. Preserve real errors; do not synthesize success or weaken scope to work around them.

CAPTCHA recognition, challenge scoring, and acceptance are controlled by the site. Even a correctly delivered captured pointer trajectory is **not a guarantee of passing a real CAPTCHA**. Do not present a canvas demonstration, scripted fixture, or successful mouse dispatch as evidence of real challenge acceptance. Request user help when appropriate.
