import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

// Keep the historical release and its dependencies out of this project's graph.
// No source checkout, patch, copied implementation, or LLM participates.
const version = "18.4.2";
const packageName = "@oh-my-pi/pi-coding-agent";
const fixture = path.resolve(
	process.env.RELAY_LEGACY_FIXTURE ??
		path.join(os.tmpdir(), `omp-relay-legacy-${version}-${process.getuid?.() ?? "user"}`),
);
await fs.mkdir(fixture, { recursive: true });
const manifest = {
	name: "omp-relay-legacy-client-fixture",
	private: true,
	type: "module",
	dependencies: { [packageName]: version, pngjs: "7.0.0", "@types/pngjs": "6.0.5" },
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestFile = Bun.file(path.join(fixture, "package.json"));
let previous = "";
try {
	previous = await manifestFile.text();
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const changed = previous !== manifestText;
if (changed) await Bun.write(manifestFile, manifestText);
let ready = false;
if (!changed) {
	try {
		Bun.resolveSync("pngjs", fixture);
		Bun.resolveSync(`${packageName}/tools/browser`, fixture);
		ready = true;
	} catch {
		// An interrupted installation may have left only its manifest.
	}
}
if (!ready) await $`${process.execPath} install --exact`.cwd(fixture);
const packageDir = path.join(fixture, "node_modules", packageName);
const packageJson: { version: string; bin: { omp: string } } = await Bun.file(
	path.join(packageDir, "package.json"),
).json();
assert.equal(packageJson.version, version, "historical contract must use the original npm 18.4.2 release");
const identity = { mode: "npm", version, packageDir, fixture };
await Bun.write(path.join(fixture, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
await Bun.write(path.join(fixture, "driver.ts"), Bun.file(path.join(import.meta.dir, "legacy-client.ts.fixture")));
console.log(`LEGACY FIXTURE: ${JSON.stringify(identity)}`);
if (process.argv.includes("--prepare")) process.exit(0);
const [relayUrl, origin] = process.argv.slice(2);
if (!relayUrl || !origin) throw new Error("Usage: bun scripts/legacy-client.ts --prepare | <relay-url> <smoke-origin>");
const home = path.join(fixture, "home");
await fs.mkdir(home, { recursive: true });
const clientEnv = {
	...process.env,
	HOME: home,
	XDG_CACHE_HOME: path.join(home, ".cache"),
	XDG_CONFIG_HOME: path.join(home, ".config"),
	XDG_DATA_HOME: path.join(home, ".local/share"),
	XDG_STATE_HOME: path.join(home, ".local/state"),
	PI_CODING_AGENT_DIR: path.join(home, ".omp/agent"),
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
assert.match(cliVersion, /\b18\.4\.2\b/);
console.log(`ORIGINAL LEGACY CLI --version: ${cliVersion}`);
const child = Bun.spawn([process.execPath, path.join(fixture, "driver.ts"), relayUrl, origin], {
	cwd: fixture,
	env: clientEnv,
	stdout: "inherit",
	stderr: "inherit",
});
const code = await child.exited;
if (code !== 0) throw new Error(`Original npm ${version} browser frontend failed (${code})`);
