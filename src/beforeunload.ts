/**
 * Page script that stops documents from registering `beforeunload` handlers.
 *
 * Chrome must bring a tab (and its window) to the foreground before it can show the
 * "Leave site?" prompt, and that native activation cannot be prevented over CDP. The only
 * way to keep an automated navigation from stealing focus is to ensure the prompt never
 * appears, so the relay installs this through `Page.addScriptToEvaluateOnNewDocument` when
 * started with `--suppress-beforeunload`.
 *
 * Limits: documents already loaded when a tab is attached keep the handlers they registered,
 * and an inline `<body onbeforeunload>` attribute compiles to a window handler without going
 * through either hook below.
 */
export const SUPPRESS_BEFORE_UNLOAD_SOURCE = `(() => {
	const marker = Symbol.for("omp-browser-relay.suppressBeforeUnload");
	if (globalThis[marker]) return;
	Object.defineProperty(globalThis, marker, { value: true });
	const addEventListener = EventTarget.prototype.addEventListener;
	EventTarget.prototype.addEventListener = function (type, ...rest) {
		if (type === "beforeunload") return;
		return addEventListener.call(this, type, ...rest);
	};
	Object.defineProperty(globalThis, "onbeforeunload", { configurable: true, get: () => null, set() {} });
})();`;
