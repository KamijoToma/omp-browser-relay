#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { version } from "../package.json";
import { startRelayServer } from "./server";

const HELP = `Usage: omp-browser-relay [serve] [--host <hostname>] [--port <port>] [--token <secret>] [--suppress-beforeunload] [--verbose]
       omp-browser-relay install [--dir <directory>]
       omp-browser-relay install-skill [--dir <directory>]
       omp-browser-relay --help | --version

Commands:
  serve          Listen for the Chrome extension and CDP clients (default: 127.0.0.1)
  install        Copy the built Chrome extension for loading as an unpacked extension
  install-skill  Copy the agent skill and canonical relay reference (opt-in)

Discovery:
  GET /capabilities  Machine-readable support, readiness and policy
  GET /docs          Canonical browser API usage reference

Options:
  --host     Advanced listener hostname (default: 127.0.0.1; 0.0.0.0 enables Tailnet source filtering)
  -p, --port  Listening port (default: 9224; 0 chooses an available port)
  --token     Require this shared secret on the extension WebSocket endpoint
  --suppress-beforeunload
              Stop pages in attached tabs from registering beforeunload handlers, so navigating
              away never raises Chrome's "Leave site?" prompt (which activates the window and
              steals focus). Also removes unsaved-changes warnings in the workspace window.
  --verbose   Log relay activity
  --dir       Install destination (extension: ~/.omp-browser-relay/extension;
              skill: ~/.agents/skills/omp-browser-relay)
  -h, --help  Show this help
  --version   Show the package version`;

interface CliOptions {
	action: "serve" | "install" | "install-skill";
	hostname: string;
	port: number;
	token?: string;
	suppressBeforeUnload: boolean;
	verbose: boolean;
	dir?: string;
	help: boolean;
	showVersion: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		action: "serve",
		hostname: "127.0.0.1",
		port: 9224,
		suppressBeforeUnload: false,
		verbose: false,
		help: false,
		showVersion: false,
	};
	const args = [...argv];
	if (args[0] === "serve" || args[0] === "install" || args[0] === "install-skill") {
		options.action = args.shift() as CliOptions["action"];
	}
	let portProvided = false;
	let hostProvided = false;
	while (args.length > 0) {
		const argument = args.shift()!;
		const separator = argument.indexOf("=");
		const flag = separator < 0 ? argument : argument.slice(0, separator);
		const inline = separator < 0 ? undefined : argument.slice(separator + 1);
		if (flag === "--port" || flag === "-p" || flag === "--host" || flag === "--token" || flag === "--dir") {
			const value = inline ?? args.shift();
			if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
			if (flag === "--port" || flag === "-p") {
				if (!/^\d+$/.test(value) || Number(value) > 65535)
					throw new Error("Port must be an integer from 0 to 65535");
				options.port = Number(value);
				portProvided = true;
			} else if (flag === "--host") {
				options.hostname = value;
				hostProvided = true;
			} else if (flag === "--token") options.token = value;
			else options.dir = value;
			continue;
		}
		if (inline !== undefined) throw new Error(`Unknown argument: ${argument}`);
		if (flag === "--verbose") options.verbose = true;
		else if (flag === "--suppress-beforeunload") options.suppressBeforeUnload = true;
		else if (flag === "--help" || flag === "-h") options.help = true;
		else if (flag === "--version") options.showVersion = true;
		else throw new Error(`Unknown argument: ${argument}`);
	}
	if (options.action === "serve" && options.dir !== undefined) {
		throw new Error("--dir is only valid for install or install-skill");
	}
	if (
		options.action !== "serve" &&
		(portProvided || hostProvided || options.token !== undefined || options.suppressBeforeUnload || options.verbose)
	) {
		throw new Error("--host, --port, --token, --suppress-beforeunload and --verbose are only valid for serve");
	}
	return options;
}

async function main(): Promise<void> {
	const options = parseArgs(Bun.argv.slice(2));
	if (options.help) {
		console.log(HELP);
		return;
	}
	if (options.showVersion) {
		console.log(version);
		return;
	}
	if (options.action === "install-skill") {
		let source = path.join(import.meta.dir, "skills", "omp-browser-relay");
		if (!(await Bun.file(path.join(source, "SKILL.md")).exists())) {
			source = path.resolve(import.meta.dir, "..", "skills", "omp-browser-relay");
		}
		if (
			!(await Bun.file(path.join(source, "SKILL.md")).exists()) ||
			!(await Bun.file(path.join(source, "reference.md")).exists())
		) {
			throw new Error("Packaged skill is missing; reinstall the package or run bun run build");
		}
		const destination = path.resolve(
			options.dir ?? path.join(os.homedir(), ".agents", "skills", "omp-browser-relay"),
		);
		if (
			destination === source ||
			source.startsWith(`${destination}${path.sep}`) ||
			destination.startsWith(`${source}${path.sep}`)
		) {
			throw new Error("Install directory must be separate from the packaged skill directory");
		}
		await fs.mkdir(destination, { recursive: true });
		await fs.cp(source, destination, { recursive: true, force: true });
		console.log(`Browser relay skill installed to ${destination}`);
		console.log("Read SKILL.md and reference.md; use the relay URL configured in browser.relayUrl.");
		return;
	}
	if (options.action === "install") {
		const source = path.join(import.meta.dir, "extension");
		if (!(await Bun.file(path.join(source, "manifest.json")).exists())) {
			throw new Error("Built extension is missing; run bun run build and use dist/cli.js install");
		}
		const destination = path.resolve(options.dir ?? path.join(os.homedir(), ".omp-browser-relay", "extension"));
		if (
			destination === source ||
			source.startsWith(`${destination}${path.sep}`) ||
			destination.startsWith(`${source}${path.sep}`)
		) {
			throw new Error("Install directory must be separate from the bundled extension directory");
		}
		await fs.mkdir(destination, { recursive: true });
		await fs.cp(source, destination, { recursive: true, force: true });
		console.log(`Browser relay extension installed to ${destination}`);
		console.log("Open chrome://extensions, enable Developer mode, then Load unpacked and select this directory.");
		return;
	}
	const relay = startRelayServer({
		hostname: options.hostname,
		port: options.port,
		token: options.token,
		suppressBeforeUnload: options.suppressBeforeUnload,
		log: options.verbose ? (message, data) => console.error(`[relay] ${message}`, data ?? "") : undefined,
	});
	const urlHost = options.hostname.includes(":") ? `[${options.hostname}]` : options.hostname;
	const baseUrl = `http://${urlHost}:${relay.port}`;
	console.log(`browser relay listening on ${baseUrl}`);
	console.log(`Capabilities: ${baseUrl}/capabilities`);
	console.log(`API reference: ${baseUrl}/docs`);
	console.log(`Extension endpoint: ws://127.0.0.1:${relay.port}/ext${options.token ? "?token=***" : ""}`);
	const stop = (): void => {
		relay.stop();
		process.exit(0);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(`omp-browser-relay: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
