import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { version } from "../package.json";
import { RELAY_CAPABILITIES } from "../src/protocol";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

async function invokeWith(
	cli: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe", ...options });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

function invoke(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return invokeWith(CLI, args);
}

describe("standalone relay CLI", () => {
	it("reports the package version", async () => {
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
			["install-skill", "--dir"],
			["install-skill", "--token", "secret"],
			["install-skill", "--verbose"],
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
			expect((await response.json()).ompRelay).toEqual(RELAY_CAPABILITIES);
			const capabilities = await (await fetch(`http://127.0.0.1:${port}/capabilities`)).json();
			expect(capabilities.package.version).toBe(version);
			expect(capabilities.backend.ready).toBeFalse();
			expect((await fetch(`http://127.0.0.1:${port}${capabilities.docs.path}`)).status).toBe(200);
			expect((await fetch(`http://127.0.0.1:${port}/ext`)).status).toBe(401);
		} finally {
			reader.releaseLock();
			child.kill("SIGTERM");
			await child.exited;
		}
	});

	it("refuses overlapping skill destinations and preserves unrelated destination files", async () => {
		const source = path.resolve(import.meta.dir, "../skills/omp-browser-relay");
		for (const destination of [source, path.dirname(source), path.join(source, "nested")]) {
			const result = await invoke("install-skill", "--dir", destination);
			expect(result.code).toBe(1);
		}
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "relay-skill-safety-"));
		try {
			await Bun.write(path.join(temporary, "user-notes.txt"), "Keep user notes");
			const result = await invoke("install-skill", "--dir", temporary);
			expect(result.code).toBe(0);
			expect(await Bun.file(path.join(temporary, "user-notes.txt")).text()).toBe("Keep user notes");
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	});

	it("runs a bundled CLI outside the repository with portable skill assets and HTTP documentation", async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "relay-bundle-"));
		try {
			const bundle = path.join(temporary, "package");
			const built = await Bun.build({ entrypoints: [CLI], outdir: bundle, target: "bun" });
			if (!built.success) throw new AggregateError(built.logs, "CLI bundle failed");
			await fs.cp(
				path.resolve(import.meta.dir, "../skills/omp-browser-relay"),
				path.join(bundle, "skills/omp-browser-relay"),
				{
					recursive: true,
				},
			);
			const cli = path.join(bundle, "cli.js");
			const destination = path.join(temporary, "installed");
			const installed = await invokeWith(cli, ["install-skill", "--dir", destination], { cwd: temporary });
			expect(installed.code).toBe(0);
			const child = Bun.spawn([process.execPath, cli, "serve", "--port=0"], {
				cwd: temporary,
				stdout: "pipe",
				stderr: "pipe",
			});
			const reader = child.stdout.getReader();
			try {
				let output = "";
				let match: RegExpExecArray | null = null;
				while (!match) {
					const chunk = await reader.read();
					if (chunk.done) throw new Error("Bundled CLI exited without its readiness banner");
					output += new TextDecoder().decode(chunk.value);
					match = /browser relay listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
				}
				const base = `http://127.0.0.1:${match[1]}`;
				const capabilities = await (await fetch(`${base}/capabilities`)).json();
				expect(capabilities.package.version).toBe(version);
				expect(capabilities.backend.ready).toBeFalse();
				const docs = await fetch(new URL(capabilities.docs.path, base));
				expect(docs.status).toBe(200);
			} finally {
				reader.releaseLock();
				child.kill("SIGTERM");
				await child.exited;
			}
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	});
});
