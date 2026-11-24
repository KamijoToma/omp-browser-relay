import * as path from "node:path";

/**
 * Command-line CDP client for the pages a relay exposes.
 *
 * It exists for interactions that stock helpers and uid-based tools cannot express: trusted clicks by coordinate or
 * visible text (including inside cross-origin iframes), text and key input into the focused element, native file
 * choosers, and screenshots whose pixels equal viewport CSS pixels. It connects to the relay's ordinary `/cdp`
 * endpoint, so it can only reach the workspace pages the relay lists, and it never injects synthetic DOM events,
 * OS input, or focus emulation.
 */
export const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";
const CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CHOOSER_TIMEOUT_MS = 6_000;

export const CLIENT_HELP = `Usage: omp-browser-relay client [--relay-url <url>] --list
       omp-browser-relay client [--relay-url <url>] <target> <command> [args...]

Drive pages in the relay workspace through trusted CDP input.

  <target>      Exact page URL, page id from --list, or a URL substring (exact matches win)
  --relay-url   Relay base URL (default: $OMP_BROWSER_RELAY_URL, else ${DEFAULT_RELAY_URL})
  --list        Print id, title and URL of every page the relay exposes
  --chooser-timeout <ms>
                How long upload commands wait for the page to open its file chooser (default: 6000)

Commands (coordinates are viewport CSS pixels):
  info                          Viewport size, device pixel ratio, URL and title
  shot <out.png>                Screenshot at 1 image pixel = 1 CSS pixel
  where <text>                  Centre of the first visible, unobscured control whose text or aria-label is <text>
  clicktext <text>              where + click (main document only)
  click <x> <y>                 Trusted left click
  dblclick <x> <y>              Trusted double click
  move <x> <y>                  Move the pointer
  wheel <x> <y> <deltaY>        Scroll with the mouse wheel
  type <text>                   Insert text into the focused element, including inside an iframe
  key <Name[+Mod...]>           Press a key: Enter, Tab, Escape, ArrowDown, Meta+a, Shift+Tab, ...
  eval <js>                     Evaluate an expression in the page and print its JSON value
  upload <x> <y> <file...>      Click, intercept the native file chooser and select the files
  uploadtext <text> <file...>   Like upload, locating the button by its text

Exit codes: 0 success, 1 runtime error, 2 usage error, 3 no file chooser opened.`;

/** An expected failure that maps to a specific process exit code. */
class ClientError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
	) {
		super(message);
	}
}
/** Malformed invocation (exit code 2). */
class UsageError extends ClientError {
	constructor(message: string) {
		super(message, 2);
	}
}

type Params = Record<string, unknown>;
interface CdpEvent {
	method?: string;
	sessionId?: string;
	params?: Params;
}
interface RelayPage {
	id: string;
	type: string;
	title?: string;
	url?: string;
}
interface Session {
	cdp<T = Params>(method: string, params?: Params): Promise<T>;
	evaluate<T>(expression: string): Promise<T>;
	waitForEvent(method: string, timeoutMs: number): Promise<Params | undefined>;
	close(): void;
}
interface Point {
	x: number;
	y: number;
}

export type ClientEnvironment = Record<string, string | undefined>;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function parseNumber(value: string | undefined, name: string): number {
	const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
	if (!Number.isFinite(parsed)) throw new UsageError(`${name} must be a number`);
	return parsed;
}

async function fetchJson<T>(baseUrl: string, pathname: string): Promise<T> {
	let response: Response;
	try {
		response = await fetch(new URL(pathname, baseUrl));
	} catch {
		throw new Error(`Cannot reach the relay at ${baseUrl}; is \`omp-browser-relay serve\` running? Use --relay-url.`);
	}
	if (!response.ok) throw new Error(`Relay ${pathname} returned HTTP ${response.status}`);
	return (await response.json()) as T;
}

async function listPages(baseUrl: string): Promise<RelayPage[]> {
	return (await fetchJson<RelayPage[]>(baseUrl, "/json/list")).filter(page => page.type === "page");
}

function resolveTarget(pages: RelayPage[], target: string): RelayPage {
	const page =
		pages.find(candidate => candidate.url === target) ??
		pages.find(candidate => candidate.id === target) ??
		pages.find(candidate => candidate.url?.includes(target));
	if (!page) throw new Error(`No relay page matches "${target}"; run \`omp-browser-relay client --list\``);
	return page;
}

async function connect(baseUrl: string, targetArgument: string): Promise<Session> {
	const page = resolveTarget(await listPages(baseUrl), targetArgument);
	const { webSocketDebuggerUrl } = await fetchJson<{ webSocketDebuggerUrl?: string }>(baseUrl, "/json/version");
	if (!webSocketDebuggerUrl) throw new Error("Relay did not advertise a CDP endpoint (is the extension connected?)");
	const socket = new WebSocket(webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("Could not open the relay CDP socket")), { once: true });
	});
	let nextId = 0;
	const pending = new Map<number, { resolve: (value: Params) => void; reject: (error: Error) => void }>();
	const listeners = new Set<(event: CdpEvent) => void>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	socket.addEventListener("message", message => {
		const data = JSON.parse(String(message.data)) as CdpEvent & { id?: number; result?: Params; error?: unknown };
		const waiter = data.id === undefined ? undefined : pending.get(data.id);
		if (waiter && data.id !== undefined) {
			pending.delete(data.id);
			if (data.error) waiter.reject(new Error(JSON.stringify(data.error)));
			else waiter.resolve(data.result ?? {});
		} else for (const listener of listeners) listener(data);
	});
	const send = (method: string, params: Params = {}, sessionId?: string): Promise<Params> => {
		const id = ++nextId;
		const { promise, resolve, reject } = Promise.withResolvers<Params>();
		const timer = setTimeout(() => {
			timers.delete(timer);
			pending.delete(id);
			reject(new Error(`CDP ${method} timed out after ${CALL_TIMEOUT_MS / 1000}s`));
		}, CALL_TIMEOUT_MS);
		timers.add(timer);
		const settle = (): void => {
			clearTimeout(timer);
			timers.delete(timer);
		};
		pending.set(id, {
			resolve: value => (settle(), resolve(value)),
			reject: error => (settle(), reject(error)),
		});
		socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		return promise;
	};
	const { sessionId } = (await send("Target.attachToTarget", { targetId: page.id, flatten: true })) as {
		sessionId: string;
	};
	const cdp = (async (method: string, params?: Params) => send(method, params, sessionId)) as Session["cdp"];
	return {
		cdp,
		async evaluate<T>(expression: string): Promise<T> {
			const response = await cdp<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
				expression,
				returnByValue: true,
				awaitPromise: true,
			});
			if (response.exceptionDetails)
				throw new Error(`Page evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
			return response.result.value;
		},
		waitForEvent(method: string, timeoutMs: number): Promise<Params | undefined> {
			const { promise, resolve } = Promise.withResolvers<Params | undefined>();
			const listener = (event: CdpEvent): void => {
				if (event.method !== method || event.sessionId !== sessionId) return;
				listeners.delete(listener);
				clearTimeout(timer);
				resolve(event.params ?? {});
			};
			const timer = setTimeout(() => {
				listeners.delete(listener);
				resolve(undefined);
			}, timeoutMs);
			listeners.add(listener);
			return promise;
		},
		close(): void {
			// Fire and forget: awaiting the reply would keep a timer alive and delay process exit.
			socket.send(JSON.stringify({ id: ++nextId, method: "Target.detachFromTarget", params: { sessionId } }));
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			socket.close();
		},
	};
}

async function click(session: Session, x: number, y: number, count = 1): Promise<void> {
	await session.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
	await sleep(60);
	for (let clickCount = 1; clickCount <= count; clickCount++) {
		await session.cdp("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			buttons: 1,
			clickCount,
		});
		await sleep(40);
		await session.cdp("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x,
			y,
			button: "left",
			buttons: 0,
			clickCount,
		});
	}
}

const KEYS: Record<string, { key: string; code: number; text?: string }> = {
	Enter: { key: "Enter", code: 13, text: "\r" },
	Tab: { key: "Tab", code: 9 },
	Escape: { key: "Escape", code: 27 },
	Backspace: { key: "Backspace", code: 8 },
	Delete: { key: "Delete", code: 46 },
	ArrowUp: { key: "ArrowUp", code: 38 },
	ArrowDown: { key: "ArrowDown", code: 40 },
	ArrowLeft: { key: "ArrowLeft", code: 37 },
	ArrowRight: { key: "ArrowRight", code: 39 },
	Space: { key: " ", code: 32, text: " " },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
/** macOS editing shortcuts only take effect through CDP when the editing command is named explicitly. */
const EDIT_COMMANDS: Record<string, string> = {
	"4:a": "selectAll",
	"4:c": "copy",
	"4:v": "paste",
	"4:x": "cut",
	"4:z": "undo",
	"12:z": "redo",
};

async function pressKey(session: Session, specification: string): Promise<void> {
	const parts = specification.split("+");
	const name = parts.pop() ?? "";
	let modifiers = 0;
	for (const part of parts) {
		const bit = MODIFIERS[part];
		if (bit === undefined) throw new UsageError(`Unknown key modifier "${part}" (use Alt, Control, Meta, Shift)`);
		modifiers |= bit;
	}
	const named = KEYS[name];
	if (!named && name.length !== 1) throw new UsageError(`Unknown key "${name}"`);
	const key = named?.key ?? name;
	const code = named?.code ?? name.toUpperCase().charCodeAt(0);
	const text = named ? named.text : name;
	const printable = text !== undefined && modifiers === 0;
	const base = { key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
	const command = EDIT_COMMANDS[`${modifiers}:${name.toLowerCase()}`];
	await session.cdp("Input.dispatchKeyEvent", {
		type: printable ? "keyDown" : "rawKeyDown",
		...base,
		...(printable ? { text } : {}),
		...(command ? { commands: [command] } : {}),
	});
	await session.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Centre of the first visible, unobscured control whose text or aria-label equals, or ends with, `text`. */
async function locate(session: Session, text: string): Promise<Point> {
	const point = await session.evaluate<Point | null>(`(() => {
		const want = ${JSON.stringify(text)};
		const normalize = value => (value || "").replace(/\\s+/g, " ").trim();
		for (const element of document.querySelectorAll('button,[role=button],[role=tab],[role=menuitem],a,label,[tabindex]')) {
			const content = normalize(element.innerText);
			const label = normalize(element.getAttribute("aria-label"));
			if (!(content === want || label === want || content.endsWith(want))) continue;
			const rect = element.getBoundingClientRect();
			if (rect.width < 2 || rect.height < 2) continue;
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			const top = document.elementFromPoint(x, y);
			if (top && (element === top || element.contains(top))) return { x: Math.round(x), y: Math.round(y) };
		}
		return null;
	})()`);
	if (!point) {
		throw new Error(
			`No visible control with text "${text}" in the main document (inside an iframe? use shot and click <x> <y>)`,
		);
	}
	return point;
}

async function upload(session: Session, point: Point, files: string[], chooserTimeoutMs: number): Promise<string> {
	const absolute = files.map(file => path.resolve(file));
	for (const file of absolute) {
		if (!(await Bun.file(file).exists())) throw new UsageError(`File not found: ${file}`);
	}
	await session.cdp("Page.enable");
	await session.cdp("Page.setInterceptFileChooserDialog", { enabled: true });
	try {
		const opened = session.waitForEvent("Page.fileChooserOpened", chooserTimeoutMs);
		await click(session, point.x, point.y);
		const chooser = await opened;
		if (!chooser) {
			throw new ClientError(
				"No file chooser opened (wrong coordinates, or the page does not use an <input type=file>)",
				3,
			);
		}
		await session.cdp("DOM.setFileInputFiles", { files: absolute, backendNodeId: chooser.backendNodeId });
		return `chooser ${String(chooser.mode)}: set ${absolute.length} file(s)`;
	} finally {
		// Never leave the shared workspace window intercepting the user's own file dialogs.
		await session.cdp("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
	}
}

interface Viewport {
	width: number;
	height: number;
	dpr: number;
}
const VIEWPORT = "JSON.stringify({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })";

async function runCommand(
	session: Session,
	command: string,
	args: string[],
	chooserTimeoutMs: number,
): Promise<string> {
	const need = (count: number, usage: string): void => {
		if (args.length < count) throw new UsageError(`Usage: ${command} ${usage}`);
	};
	switch (command) {
		case "info":
			return await session.evaluate<string>(
				"JSON.stringify({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, url: location.href, title: document.title })",
			);
		case "shot": {
			need(1, "<out.png>");
			const viewport = JSON.parse(await session.evaluate<string>(VIEWPORT)) as Viewport;
			const { data } = await session.cdp<{ data: string }>("Page.captureScreenshot", {
				format: "png",
				clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 / viewport.dpr },
			});
			await Bun.write(args[0]!, Buffer.from(data, "base64"));
			return `saved ${args[0]} (${viewport.width}x${viewport.height}; image pixels are CSS pixels)`;
		}
		case "where":
			need(1, "<text>");
			return JSON.stringify(await locate(session, args.join(" ")));
		case "clicktext": {
			need(1, "<text>");
			const text = args.join(" ");
			const point = await locate(session, text);
			await click(session, point.x, point.y);
			return `clicked "${text}" at ${point.x},${point.y}`;
		}
		case "click":
		case "dblclick":
			need(2, "<x> <y>");
			await click(session, parseNumber(args[0], "x"), parseNumber(args[1], "y"), command === "dblclick" ? 2 : 1);
			return command === "click" ? "clicked" : "double-clicked";
		case "move":
			need(2, "<x> <y>");
			await session.cdp("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: parseNumber(args[0], "x"),
				y: parseNumber(args[1], "y"),
				button: "none",
				buttons: 0,
			});
			return "moved";
		case "wheel":
			need(3, "<x> <y> <deltaY>");
			await session.cdp("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: parseNumber(args[0], "x"),
				y: parseNumber(args[1], "y"),
				deltaX: 0,
				deltaY: parseNumber(args[2], "deltaY"),
			});
			return "wheeled";
		case "type":
			need(1, "<text>");
			await session.cdp("Input.insertText", { text: args.join(" ") });
			return "typed";
		case "key":
			need(1, "<Name[+Mod...]>");
			await pressKey(session, args[0]!);
			return `key ${args[0]}`;
		case "eval":
			need(1, "<js>");
			return JSON.stringify((await session.evaluate<unknown>(args.join(" "))) ?? null);
		case "upload":
			need(3, "<x> <y> <file...>");
			return await upload(
				session,
				{ x: parseNumber(args[0], "x"), y: parseNumber(args[1], "y") },
				args.slice(2),
				chooserTimeoutMs,
			);
		case "uploadtext":
			need(2, "<text> <file...>");
			return await upload(session, await locate(session, args[0]!), args.slice(1), chooserTimeoutMs);
		default:
			throw new UsageError(`Unknown client command "${command}"; see omp-browser-relay client --help`);
	}
}

/** Runs `omp-browser-relay client ...` and returns the process exit code. */
export async function runClient(argv: string[], environment: ClientEnvironment = process.env): Promise<number> {
	const args = [...argv];
	let relayUrl = environment.OMP_BROWSER_RELAY_URL || DEFAULT_RELAY_URL;
	let list = false;
	let chooserTimeoutMs = DEFAULT_CHOOSER_TIMEOUT_MS;
	try {
		while (args[0]?.startsWith("--")) {
			const argument = args.shift()!;
			const separator = argument.indexOf("=");
			const flag = separator < 0 ? argument : argument.slice(0, separator);
			if (flag === "--help") {
				console.log(CLIENT_HELP);
				return 0;
			}
			if (flag === "--list") {
				list = true;
				continue;
			}
			if (flag === "--relay-url" || flag === "--chooser-timeout") {
				const value = separator < 0 ? args.shift() : argument.slice(separator + 1);
				if (!value || value.startsWith("--")) throw new UsageError(`${flag} requires a value`);
				if (flag === "--relay-url") relayUrl = value;
				else {
					chooserTimeoutMs = parseNumber(value, "--chooser-timeout");
					if (chooserTimeoutMs <= 0) throw new UsageError("--chooser-timeout must be positive");
				}
				continue;
			}
			throw new UsageError(`Unknown client option: ${argument}`);
		}
		if (list) {
			if (args.length > 0) throw new UsageError("--list takes no target or command");
			for (const page of await listPages(relayUrl))
				console.log(`${page.id}\t${(page.title ?? "").slice(0, 40)}\t${page.url ?? ""}`);
			return 0;
		}
		const [target, command, ...rest] = args;
		if (!target || !command)
			throw new UsageError(
				`Usage: omp-browser-relay client [--relay-url <url>] <target> <command> [args...]\n\n${CLIENT_HELP}`,
			);
		const session = await connect(relayUrl, target);
		try {
			console.log(await runCommand(session, command, rest, chooserTimeoutMs));
		} finally {
			session.close();
		}
		return 0;
	} catch (error) {
		console.error(`omp-browser-relay: ${error instanceof Error ? error.message : String(error)}`);
		return error instanceof ClientError ? error.exitCode : 1;
	}
}
