import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "dist");
const extension = path.join(dist, "extension");
await fs.rm(dist, { recursive: true, force: true });

for (const [entry, outdir, target] of [
	["extension/background.ts", extension, "browser"],
	["src/cli.ts", dist, "bun"],
] as const) {
	const result = await Bun.build({ entrypoints: [path.join(root, entry)], outdir, target, sourcemap: "none" });
	if (!result.success) throw new AggregateError(result.logs, `Failed to build ${entry}`);
}

for (const name of ["manifest.json", "options.html", "options.js"]) {
	await Bun.write(path.join(extension, name), Bun.file(path.join(root, "extension", name)));
}
await Bun.write(path.join(extension, "LICENSE"), Bun.file(path.join(root, "LICENSE")));
await fs.cp(path.join(root, "skills", "omp-browser-relay"), path.join(dist, "skills", "omp-browser-relay"), {
	recursive: true,
});
await fs.chmod(path.join(dist, "cli.js"), 0o755);

const zip = await $`zip -qr ../omp-browser-relay-extension.zip .`.cwd(extension).quiet().nothrow();
if (zip.exitCode !== 0) throw new Error(`Could not package extension: ${zip.stderr.toString()}`);
console.log(`Built ${path.join(dist, "cli.js")}`);
console.log(`Built ${extension}`);
console.log(`Built ${path.join(dist, "omp-browser-relay-extension.zip")}`);
