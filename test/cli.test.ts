import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { version } from "../package.json";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

async function invoke(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

describe("standalone relay CLI", () => {
	it("prints help and version without starting a server", async () => {
		const help = await invoke("--help");
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("omp-browser-relay");
		expect(help.stdout).toContain("install");
		const result = await invoke("--version");
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe(version);
	});

	it("rejects unknown options, missing values, invalid ports and command-specific options", async () => {
		for (const args of [
			["unknown"],
			["--no-group"],
			["--port"],
			["--token"],
			["--port", "-1"],
			["--port", "65536"],
			["--port", "12.5"],
			["serve", "--dir", "/tmp/unused"],
			["install", "--port", "9224"],
			["install", "--dir"],
		]) {
			const result = await invoke(...args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("omp-browser-relay:");
		}
	});

	it("fails instead of taking over an occupied port", async () => {
		const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated service") });
		try {
			const result = await invoke("serve", "-p", String(occupied.port));
			expect(result.code).toBe(1);
			expect(result.stdout).not.toContain("browser relay listening");
			expect(await (await fetch(`http://127.0.0.1:${occupied.port}/`)).text()).toBe("unrelated service");
		} finally {
			occupied.stop(true);
		}
	});

	it("serves by default, reports the actual ephemeral port and does not print the token", async () => {
		const child = Bun.spawn([process.execPath, CLI, "--port=0", "--token", "private-secret"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = child.stdout.getReader();
		try {
			let output = "";
			let match: RegExpExecArray | null = null;
			while (!match) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("CLI exited without its readiness banner");
				output += new TextDecoder().decode(chunk.value);
				match = /browser relay listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
			}
			const port = Number(match[1]);
			expect(port).toBeGreaterThan(0);
			expect(output).not.toContain("private-secret");
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			expect(response.status).toBe(503);
			expect((await response.json()).ompRelay).toEqual({ protocolVersion: 2, windowIsolation: "dedicated-window" });
			expect((await fetch(`http://127.0.0.1:${port}/ext`)).status).toBe(401);
		} finally {
			reader.releaseLock();
			child.kill("SIGTERM");
			await child.exited;
		}
	});
});
