import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { SUPPRESS_BEFORE_UNLOAD_SOURCE } from "../src/beforeunload";

interface FakeTarget {
	addEventListener(type: string, listener: () => void, options?: unknown): void;
}

/** A context with just enough of the DOM event surface for the script to patch. */
function pageContext(): { global: Record<string, unknown>; registered: string[]; target: FakeTarget } {
	const registered: string[] = [];
	class EventTarget {
		addEventListener(type: string, _listener: () => void, _options?: unknown): void {
			registered.push(type);
		}
	}
	const global: Record<string, unknown> = { EventTarget };
	vm.createContext(global);
	return { global, registered, target: new EventTarget() };
}

function install(global: Record<string, unknown>): void {
	vm.runInContext(SUPPRESS_BEFORE_UNLOAD_SOURCE, global);
}

describe("beforeunload suppression script", () => {
	it("drops beforeunload listeners but forwards every other event with its arguments", () => {
		const { global, registered, target } = pageContext();
		install(global);
		const listener = (): void => {};
		target.addEventListener("beforeunload", listener);
		target.addEventListener("beforeunload", listener, { capture: true });
		target.addEventListener("click", listener, { once: true });
		target.addEventListener("unload", listener);
		expect(registered).toEqual(["click", "unload"]);
	});

	it("keeps `this` bound to the receiving target", () => {
		const { global } = pageContext();
		const seen: unknown[] = [];
		const proto = (global.EventTarget as { prototype: { addEventListener(...args: unknown[]): void } }).prototype;
		const original = proto.addEventListener;
		proto.addEventListener = function (this: unknown, ...args: unknown[]) {
			seen.push(this);
			return original.apply(this, args);
		};
		install(global);
		const target = new (global.EventTarget as new () => FakeTarget)();
		target.addEventListener("click", () => {});
		expect(seen).toEqual([target]);
	});

	it("neutralizes the onbeforeunload property", () => {
		const { global } = pageContext();
		install(global);
		global.onbeforeunload = () => "unsaved changes";
		expect(vm.runInContext("onbeforeunload", global)).toBeNull();
	});

	it("is idempotent when a document runs it more than once", () => {
		const { global, registered, target } = pageContext();
		install(global);
		install(global);
		target.addEventListener("click", () => {});
		target.addEventListener("beforeunload", () => {});
		expect(registered).toEqual(["click"]);
	});

	it("does not touch handlers registered before it ran", () => {
		const { global, registered, target } = pageContext();
		target.addEventListener("beforeunload", () => {});
		install(global);
		expect(registered).toEqual(["beforeunload"]);
	});
});
