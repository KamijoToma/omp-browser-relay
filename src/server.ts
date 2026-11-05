/**
 * HTTP + WebSocket server for the browser relay.
 *
 * Impersonates Chrome's CDP discovery endpoint so the omp browser tool (and
 * any puppeteer client) can connect with a plain `browserURL`:
 * - `GET /json/version` → 200 with `webSocketDebuggerUrl` once the extension
 *   is connected, 503 with a {@link RelayUnavailableInfo} body before that
 *   (`waitForRelayExtension` decides from it whether polling is worthwhile).
 * - `GET /json` / `/json/list` → attachable page targets (debugging aid).
 * - `WS /cdp` → downstream CDP clients (puppeteer).
 * - `WS /ext` → the Chrome extension (token-gated when configured).
 *
 * The loopback listener is always available. Tailnet mode adds remote CDP
 * access with source filtering; CDP clients remain unauthenticated.
 */
import { networkInterfaces } from "node:os";
import { RelayBridge } from "./bridge";
import { RELAY_REFERENCE, relayCapabilities } from "./capabilities";
import {
	RELAY_CAPABILITIES,
	type RelayUnavailableInfo,
	type TailnetAccessAck,
	type TailnetAccessRequest,
	type TailnetAccessResult,
} from "./protocol";

export type { RelayUnavailableInfo } from "./protocol";

/** Options for {@link startRelayServer}. */
export interface RelayServerOptions {
	port: number;
	/** Network hostname or interface to listen on; defaults to loopback only. */
	hostname?: string;
	/** Shared secret the extension must present as `?token=`; unset disables the check. */
	token?: string;
	/**
	 * Stop pages in attached tabs from registering `beforeunload` handlers. Leaving a page that has
	 * one makes Chrome raise a prompt, which activates the workspace window and steals native focus.
	 * Off by default because it also removes "unsaved changes" warnings for people using the window.
	 */
	suppressBeforeUnload?: boolean;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

/** A running relay server. */
export interface RelayServer {
	bridge: RelayBridge;
	port: number;
	stop(): void;
}

interface SocketData {
	role: "cdp" | "ext";
	isLocal: boolean;
	connId?: number;
}

type RelayWebSocket = Bun.ServerWebSocket<SocketData>;

const WS_KEEPALIVE_MS = 30_000;
/** Screenshots travel base64-encoded through both websocket legs. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** True when `raw` can serve as the authority of a `ws://` URL: no whitespace,
 *  slashes, userinfo, fragments, or control characters, and URL-parseable. */
function isWsAuthority(raw: string): boolean {
	if (/[\s/\\@#?\p{Cc}]/u.test(raw)) return false;
	try {
		return new URL(`ws://${raw}`).host.length > 0;
	} catch {
		return false;
	}
}
/** Tailscale's IPv4 allocation is within 100.64.0.0/10. */
function isTailnetIpv4(address: string): boolean {
	const normalized = address.toLowerCase().replace(/^::ffff:/, "");
	const octets = normalized.split(".");
	if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet))) return false;
	const [first, second, third, fourth] = octets.map(Number);
	return first === 100 && second! >= 64 && second <= 127 && third! <= 255 && fourth! <= 255;
}

function getTailnetIpv4Addresses(): string[] {
	const addresses = new Set<string>();
	for (const interfaces of Object.values(networkInterfaces())) {
		for (const address of interfaces ?? []) {
			if (isTailnetIpv4(address.address)) addresses.add(address.address);
		}
	}
	return [...addresses].sort();
}

/** Start the relay on the configured hostname (loopback by default). */
export function startRelayServer(opts: RelayServerOptions): RelayServer {
	const log = opts.log ?? (() => {});
	let hostname = opts.hostname ?? "127.0.0.1";
	const bridge = new RelayBridge({ log, suppressBeforeUnload: opts.suppressBeforeUnload });
	const sockets = new Set<RelayWebSocket>();
	const startedAt = Date.now();
	let tailnetAccessEnabled = hostname === "0.0.0.0";
	let pendingTailnetTransition:
		| { requestId: number; enabled: boolean; socket: RelayWebSocket; timer: Timer }
		| undefined;
	let server: Bun.Server<SocketData>;
	let rebindInProgress = false;
	let stopped = false;

	const createListener = (listenHostname: string, port: number): Bun.Server<SocketData> =>
		Bun.serve<SocketData>({
			hostname: listenHostname,
			port,
			fetch(req, srv): Response | undefined {
				const address = srv.requestIP(req)?.address ?? "";
				const normalizedAddress = address.toLowerCase().replace(/^::ffff:/, "");
				const local = normalizedAddress === "::1" || normalizedAddress.startsWith("127.");
				if (!local && !(tailnetAccessEnabled && isTailnetIpv4(address))) {
					return new Response("Forbidden", { status: 403 });
				}
				const urlHost = listenHostname.includes(":") ? `[${listenHostname}]` : listenHostname;
				const fallback = `${urlHost}:${srv.port}`;
				const rawHost = req.headers.get("host")?.trim();
				const host = rawHost && isWsAuthority(rawHost) ? rawHost : fallback;
				const requestUrl =
					rawHost && rawHost !== host && req.url.startsWith(`http://${rawHost}`)
						? req.url.slice(`http://${rawHost}`.length)
						: req.url;
				const url = new URL(requestUrl, `http://${fallback}`);
				const path = url.pathname.replace(/\/+$/, "") || "/";
				if (path === "/cdp") {
					// Browsers set Origin on websocket upgrades; native CDP clients
					// don't. Reject any Origin so a web page can't drive the relay.
					if (req.headers.get("origin")) return new Response("Forbidden", { status: 403 });
					const data: SocketData = { role: "cdp", isLocal: local };
					if (srv.upgrade(req, { data })) return undefined;
					return new Response("websocket upgrade required", { status: 426 });
				}
				if (path === "/ext") {
					if (!local) return new Response("Forbidden", { status: 403 });
					const origin = req.headers.get("origin");
					if (origin && !origin.startsWith("chrome-extension://")) {
						return new Response("Forbidden", { status: 403 });
					}
					if (opts.token && url.searchParams.get("token") !== opts.token) {
						return new Response("Unauthorized", { status: 401 });
					}
					const data: SocketData = { role: "ext", isLocal: true };
					if (srv.upgrade(req, { data })) return undefined;
					return new Response("websocket upgrade required", { status: 426 });
				}
				if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
				if (path === "/capabilities") {
					return Response.json(
						relayCapabilities(bridge.ready, bridge.extensionSeen, bridge.suppressesBeforeUnload),
					);
				}
				if (path === "/docs") {
					return new Response(RELAY_REFERENCE, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
				}
				if (path === "/json/version") {
					if (!bridge.ready) {
						const info: RelayUnavailableInfo = {
							error: "relay extension is not connected",
							extensionSeen: bridge.extensionSeen,
							uptimeMs: Date.now() - startedAt,
							ompRelay: RELAY_CAPABILITIES,
							...bridge.discoveryStatus(),
							...(bridge.extensionGoneForMs === null ? {} : { disconnectedMs: bridge.extensionGoneForMs }),
						};
						return Response.json(info, { status: 503 });
					}
					return Response.json(bridge.versionInfo(`ws://${host}/cdp`));
				}
				if (path === "/json" || path === "/json/list") {
					return Response.json(bridge.listTargets());
				}
				return new Response("Not found", { status: 404 });
			},
			websocket: {
				maxPayloadLength: MAX_PAYLOAD_BYTES,
				// Disabled: Bun caps idleTimeout at 255s, and the keepalive pings
				// below already detect dead peers via the websocket close path.
				idleTimeout: 0,
				open(ws: RelayWebSocket): void {
					sockets.add(ws);
					if (ws.data.role === "ext") {
						bridge.extConnected(ws);
					} else {
						ws.data.connId = bridge.cdpConnected(ws);
					}
				},
				message(ws: RelayWebSocket, message: string | Buffer): void {
					const text = typeof message === "string" ? message : new TextDecoder().decode(message);
					if (ws.data.role === "ext") {
						let incoming: unknown;
						try {
							incoming = JSON.parse(text);
						} catch {
							bridge.extMessage(ws, text);
							return;
						}
						if (
							ws.data.isLocal &&
							incoming !== null &&
							typeof incoming === "object" &&
							"t" in incoming &&
							incoming.t === "tailnetAccessAck"
						) {
							const ack = incoming as TailnetAccessAck;
							const transition = pendingTailnetTransition;
							if (
								transition !== undefined &&
								Number.isSafeInteger(ack.requestId) &&
								transition.requestId === ack.requestId &&
								transition.socket === ws
							) {
								clearTimeout(transition.timer);
								pendingTailnetTransition = undefined;
								const previousHostname = hostname;
								const previousAccess = tailnetAccessEnabled;
								const port = server.port!;
								const nextHostname = transition.enabled ? "0.0.0.0" : "127.0.0.1";
								const currentServer = server;
								rebindInProgress = true;
								void currentServer.stop(true).then(
									() => {
										if (stopped) {
											rebindInProgress = false;
											return;
										}
										try {
											// Rebind one listener instead of relying on SO_REUSEPORT across platforms.
											server = createListener(nextHostname, port);
											hostname = nextHostname;
											tailnetAccessEnabled = transition.enabled;
											log("tailnet access changed", {
												enabled: tailnetAccessEnabled,
												hostname,
												port: server.port,
											});
										} catch {
											hostname = previousHostname;
											tailnetAccessEnabled = previousAccess;
											try {
												server = createListener(previousHostname, port);
											} catch {
												log("relay listener recovery failed", { port });
												rebindInProgress = false;
												return;
											}
											log("tailnet access rebind failed", {
												enabled: transition.enabled,
												hostname: previousHostname,
												port: server.port,
											});
										}
										rebindInProgress = false;
									},
									() => {
										rebindInProgress = false;
										log("relay listener stop failed", { port });
									},
								);
							}
							return;
						}
						if (
							ws.data.isLocal &&
							incoming !== null &&
							typeof incoming === "object" &&
							"t" in incoming &&
							incoming.t === "tailnetAccessRequest"
						) {
							const request = incoming as TailnetAccessRequest;
							if (!Number.isSafeInteger(request.requestId) || request.requestId < 1) return;
							let error: string | undefined;
							let rebindRequired = false;
							if (request.enabled !== undefined) {
								if (typeof request.enabled !== "boolean") {
									error = "Invalid Tailnet access setting.";
								} else if (pendingTailnetTransition || rebindInProgress) {
									error = "A Tailnet listener change is already in progress.";
								} else if (request.enabled !== tailnetAccessEnabled) {
									const nextHostname = request.enabled ? "0.0.0.0" : "127.0.0.1";
									if (nextHostname === hostname) {
										tailnetAccessEnabled = request.enabled;
									} else {
										pendingTailnetTransition = {
											requestId: request.requestId,
											enabled: request.enabled,
											socket: ws,
											timer: setTimeout(() => {
												if (pendingTailnetTransition?.requestId !== request.requestId) return;
												pendingTailnetTransition = undefined;
												log("tailnet access transition timed out", {
													requestId: request.requestId,
													port: server.port,
												});
											}, 10_000),
										};
										rebindRequired = true;
									}
								}
							}
							const result: TailnetAccessResult = {
								t: "tailnetAccessResult",
								requestId: request.requestId,
								ok: error === undefined,
								enabled: rebindRequired ? request.enabled! : tailnetAccessEnabled,
								port: server.port!,
								tailnetAddresses: getTailnetIpv4Addresses(),
								...(rebindRequired ? { rebindRequired: true } : {}),
								...(error === undefined ? {} : { error }),
							};
							ws.send(JSON.stringify(result));
							return;
						}
						bridge.extMessage(ws, text);
					} else if (ws.data.connId !== undefined) {
						bridge.cdpMessage(ws.data.connId, text);
					}
				},
				close(ws: RelayWebSocket): void {
					sockets.delete(ws);
					if (ws.data.role === "ext") {
						if (pendingTailnetTransition?.socket === ws) {
							clearTimeout(pendingTailnetTransition.timer);
							pendingTailnetTransition = undefined;
						}
						bridge.extClosed(ws);
					} else if (ws.data.connId !== undefined) {
						bridge.cdpClosed(ws.data.connId);
					}
				},
			},
		});

	server = createListener(hostname, opts.port);

	// Puppeteer connections go silent while the agent is idle; protocol-level
	// pings count as activity and keep them under the idle timeout.
	const keepalive = setInterval(() => {
		for (const ws of sockets) ws.ping();
	}, WS_KEEPALIVE_MS);
	keepalive.unref();

	log("relay listening", { hostname, port: server.port, tailnetAccessEnabled });
	return {
		bridge,
		port: server.port!,
		stop() {
			stopped = true;
			clearInterval(keepalive);
			if (pendingTailnetTransition) clearTimeout(pendingTailnetTransition.timer);
			server.stop(true);
		},
	};
}
