import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

// This launcher never imports omp into the relay's dependency graph. Only our
// driver is copied; package code is installed verbatim or linked read-only.
const version = "18.12.2";
const source = process.env.RELAY_UPSTREAM_SOURCE;
const fixture = path.resolve(
	process.env.RELAY_UPSTREAM_FIXTURE ??
		path.join(os.tmpdir(), `omp-relay-upstream-${source ? "source" : version}-${process.getuid?.() ?? "user"}`),
);
const packageName = "@oh-my-pi/pi-coding-agent";
const packageDir = source
	? path.resolve(source, "packages/coding-agent")
	: path.join(fixture, "node_modules", packageName);
await fs.mkdir(fixture, { recursive: true });
const manifest = {
	name: "omp-relay-original-client-fixture",
	private: true,
	type: "module",
	dependencies: { ...(source ? {} : { [packageName]: version }), pngjs: "7.0.0", "@types/pngjs": "6.0.5" },
};
const manifestPath = path.join(fixture, "package.json");
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestFile = Bun.file(manifestPath);
let previous = "";
try {
	previous = await manifestFile.text();
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const manifestChanged = previous !== manifestText;
if (manifestChanged) await Bun.write(manifestFile, manifestText);
let dependenciesReady = false;
if (!manifestChanged) {
	try {
		Bun.resolveSync("pngjs", fixture);
		if (!source) Bun.resolveSync(`${packageName}/tools/browser`, fixture);
		dependenciesReady = true;
	} catch {
		// An interrupted preparation may have left its manifest but not its dependencies.
	}
}
if (!dependenciesReady) await $`${process.execPath} install --exact`.cwd(fixture);
if (source) {
	const link = path.join(fixture, "node_modules", packageName);
	await fs.mkdir(path.dirname(link), { recursive: true });
	try {
		await fs.symlink(packageDir, link, "dir");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		assert.equal(
			await fs.realpath(link),
			await fs.realpath(packageDir),
			"fixture belongs to a different source checkout",
		);
	}
}
const packageJson: { version: string; bin: { omp: string } } = await Bun.file(
	path.join(packageDir, "package.json"),
).json();
assert.equal(packageJson.version, version, "this contract driver is pinned to omp 18.12.2");
const revision = source ? process.env.RELAY_UPSTREAM_REVISION : undefined;
if (source) {
	for (const dependency of [
		"@oh-my-pi/omptype",
		"@oh-my-pi/pi-natives",
		"@oh-my-pi/pi-tui/tools/streaming-output",
		"puppeteer-core",
	]) {
		try {
			Bun.resolveSync(dependency, path.join(packageDir, "src"));
		} catch (error) {
			throw new Error(
				`Source checkout dependency missing: ${dependency}. Prepare the upstream checkout separately; no files were changed there.`,
				{ cause: error },
			);
		}
	}
}
const identity = { mode: source ? "source" : "npm", version, revision, packageDir, fixture };
await Bun.write(path.join(fixture, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
await Bun.write(path.join(fixture, "driver.ts"), Bun.file(path.join(import.meta.dir, "upstream-client.ts.fixture")));
console.log(`UPSTREAM FIXTURE: ${JSON.stringify(identity)}`);
if (process.argv.includes("--prepare")) process.exit(0);
const [relayUrl, origin] = process.argv.slice(2);
if (!relayUrl || !origin)
	throw new Error("Usage: bun scripts/upstream-client.ts --prepare | <relay-url> <smoke-origin>");
const isolatedHome = path.join(fixture, "home");
await fs.mkdir(isolatedHome, { recursive: true });
const clientEnv = {
	...process.env,
	HOME: isolatedHome,
	XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
	XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
	XDG_DATA_HOME: path.join(isolatedHome, ".local/share"),
	XDG_STATE_HOME: path.join(isolatedHome, ".local/state"),
	PI_CODING_AGENT_DIR: path.join(isolatedHome, ".omp/agent"),
	OMP_PROFILE: "",
	PI_PROFILE: "",
	PI_BROWSER_RELAY: "1",
};
const cliVersion = (
	await $`${process.execPath} ${path.join(packageDir, packageJson.bin.omp)} --version`
		.cwd(fixture)
		.env(clientEnv)
		.quiet()
		.text()
).trim();
assert.match(cliVersion, /\b18\.12\.2\b/, "CLI must identify the selected original release");
console.log(`ORIGINAL CLI --version: ${cliVersion}`);
const driver = Bun.spawn([process.execPath, path.join(fixture, "driver.ts"), relayUrl, origin], {
	cwd: fixture,
	env: clientEnv,
	stdout: "inherit",
	stderr: "inherit",
});
const exitCode = await driver.exited;
if (exitCode !== 0) throw new Error(`Original ${identity.mode} browser frontend failed (${exitCode})`);
