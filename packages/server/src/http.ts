import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { collectRoots, isImageMime, kcError, type KcError } from "@kirochrome/shared";
import type {
  AgentSessionsResponse,
  ProviderView,
  RoomInput,
  Schedule,
  ScheduleInput,
  SchedulesResponse,
} from "@kirochrome/shared";
import { listAgentSessions } from "./agentSessions.js";
import { checkProvider } from "./check.js";
import { exportFilename, toMarkdown } from "./export.js";
import { listDirectory, rawFile, readText, validateRoot } from "./files.js";
import { loadConfig, updateProvider } from "./config.js";
import { RoomManager } from "./rooms.js";
import { Scheduler } from "./scheduler.js";
import { SessionManager } from "./sessionManager.js";
import { Store } from "./store.js";
import { attachWebSocket } from "./ws.js";

const HOST = "127.0.0.1";

const VITE_PORT = 5173;

/**
 * Any page in the user's browser can send requests to a local server, so we
 * check Origin explicitly rather than relying on binding to loopback.
 *
 * Vite's dev origin is trusted only when the dev runner asks for it. It used to
 * be in this list unconditionally, including in a built install — and since
 * 5173 is Vite's default, *any* other project the user happened to be running
 * could reach this API. `PATCH /api/providers/:id` chooses which binary we
 * spawn, so that was a page on one origin choosing what runs on the machine.
 */
export function originAllowed(req: IncomingMessage, port: number): boolean {
  // Same-origin GETs send no Origin, so a page on a DNS-rebound name that
  // resolves to 127.0.0.1 would pass the Origin check by omission. The Host
  // header is what such a page cannot fake: require it to be us, on our port.
  if (!hostAllowed(req.headers.host, port)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true; // same-origin fetch or curl
  return allowedOrigins(port).has(origin);
}

function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}`;
}

function allowedOrigins(port: number): Set<string> {
  const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  if (process.env.KIROCHROME_DEV === "1") {
    allowed.add(`http://localhost:${VITE_PORT}`);
    allowed.add(`http://127.0.0.1:${VITE_PORT}`);
  }
  return allowed;
}

/**
 * The error a rejected request gets. It names the origin and what would have
 * been accepted: "Origin not allowed" on its own left someone staring at a
 * working server and a working page that would not talk to each other.
 */
export function originRejection(req: IncomingMessage, port: number): KcError {
  const origin = req.headers.origin ?? "(none)";
  const host = req.headers.host ?? "(none)";
  const allowed = [...allowedOrigins(port)];
  const message = hostAllowed(host, port)
    ? `Requests from ${origin} are not accepted.`
    : `Requests addressed to ${host} are not accepted; this server answers only as localhost or 127.0.0.1.`;
  return kcError("ORIGIN_REJECTED", message, {
    detail: { origin, host, allowed, devMode: process.env.KIROCHROME_DEV === "1" },
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export function startServer(port: number, webRoot: string | null): void {
  const store = new Store();
  const sessions = new SessionManager(store);
  const scheduler = new Scheduler(store, sessions, () => loadConfig().providers);
  scheduler.start();
  const rooms = new RoomManager(store, sessions, () => loadConfig().providers);
  rooms.start();

  const server = createServer(async (req, res) => {
    if (!originAllowed(req, port)) {
      return sendError(res, 403, originRejection(req, port));
    }

    const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
    try {
      if (url.pathname.startsWith("/api/schedules")) return await handleSchedules(req, res, url, scheduler);
      if (url.pathname.startsWith("/api/rooms")) return await handleRooms(req, res, url, rooms);
      if (/^\/api\/sessions\/[^/]+\/(files|file|raw|roots)$/.test(url.pathname)) {
        return await handleFiles(req, res, url, store, sessions);
      }
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, store);
      if (webRoot) return serveStatic(res, webRoot, url.pathname);
      return sendJson(res, 404, { error: kcError("INTERNAL", "No web build. Run `npm run build`.") });
    } catch (err) {
      const error: KcError =
        typeof err === "object" && err !== null && "code" in err
          ? (err as KcError)
          : kcError("INTERNAL", "Unhandled server error.", { cause: String(err) });
      sendError(res, statusFor(error), error);
    }
  });

  attachWebSocket(server, sessions, (req) => originAllowed(req, port));

  server.listen(port, HOST, () => {
    console.log(`KiroChrome on http://${HOST}:${port}`);
  });

  // Agents are child processes; leaving them behind is the orphan bug we
  // designed against, so tear them down on the way out.
  const shutdown = () => {
    scheduler.stop();
    sessions.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: Store,
): Promise<void> {
  const config = loadConfig();

  // GET /api/providers — the setup page's list, each with its last check.
  if (url.pathname === "/api/providers" && req.method === "GET") {
    const providers: ProviderView[] = config.providers.map((p) => ({
      ...p,
      lastCheck: store.lastCheck(p.id),
    }));
    return sendJson(res, 200, { providers, platform: hostPlatform() });
  }

  // PATCH /api/providers/:id — correct a command path without editing JSON.
  const patchMatch = /^\/api\/providers\/([^/]+)$/.exec(url.pathname);
  if (patchMatch && req.method === "PATCH") {
    const id = decodeURIComponent(patchMatch[1]!);
    const body = (await readJson(req)) as { command?: unknown; args?: unknown };
    const patch: { command?: string; args?: string[] } = {};
    if (typeof body.command === "string" && body.command.trim()) patch.command = body.command.trim();
    if (Array.isArray(body.args) && body.args.every((a) => typeof a === "string")) {
      patch.args = body.args as string[];
    }
    if (Object.keys(patch).length === 0) {
      return sendError(res, 400, kcError("CONFIG_INVALID", "Nothing to update."));
    }
    updateProvider(id, patch);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/attachments/:id — pasted images, referenced by the event log.
  const attachmentMatch = /^\/api\/attachments\/([^/]+)$/.exec(url.pathname);
  if (attachmentMatch && req.method === "GET") {
    const stored = store.attachment(decodeURIComponent(attachmentMatch[1]!));
    if (!stored) return sendError(res, 404, kcError("INTERNAL", "No such attachment."));

    const body = Buffer.from(stored.data, "base64");
    res.writeHead(200, {
      // Rows predating the boundary check can hold any string, and this is the
      // one place stored bytes are served back to the browser: re-check rather
      // than trust the database, and forbid sniffing so a mislabelled body is
      // not promoted to script.
      "content-type": isImageMime(stored.mime) ? stored.mime : "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-length": String(body.length),
      // Immutable: attachments are never rewritten once stored.
      "cache-control": "private, max-age=31536000, immutable",
    });
    res.end(body);
    return;
  }

  // GET /api/sessions/:id/export — the conversation as Markdown.
  const exportMatch = /^\/api\/sessions\/([^/]+)\/export$/.exec(url.pathname);
  if (exportMatch && req.method === "GET") {
    const id = decodeURIComponent(exportMatch[1]!);
    const record = store.getSession(id);
    if (!record) {
      return sendError(res, 404, kcError("SESSION_UNKNOWN", `No conversation with id '${id}'.`));
    }
    const markdown = toMarkdown(record, store.eventsSince(id, 0));
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(record)}"`,
    });
    res.end(markdown);
    return;
  }

  // GET /api/providers/:id/sessions — conversations the *agent* is holding.
  //
  // HTTP rather than the socket: this runs before any conversation exists, so
  // it is a request/response with nothing to stream, and it needs its own
  // short-lived probe agent — exactly the shape of the check below.
  const listMatch = /^\/api\/providers\/([^/]+)\/sessions$/.exec(url.pathname);
  if (listMatch && req.method === "GET") {
    const id = decodeURIComponent(listMatch[1]!);
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) {
      return sendError(res, 404, kcError("PROVIDER_UNKNOWN", `No provider configured with id '${id}'.`));
    }
    const listed = await listAgentSessions(provider);
    // Which of them we already hold, so the UI opens those instead of
    // adopting one agent session into a second conversation.
    const adopted: Record<string, string> = {};
    for (const info of listed.sessions) {
      const held = store.sessionByAgentSessionId(info.sessionId);
      if (held) adopted[info.sessionId] = held.id;
    }
    const body: AgentSessionsResponse = { ...listed, adopted };
    return sendJson(res, 200, body);
  }

  // POST /api/providers/:id/check — run the ladder.
  const match = /^\/api\/providers\/([^/]+)\/check$/.exec(url.pathname);
  if (match && req.method === "POST") {
    const id = decodeURIComponent(match[1]!);
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) {
      return sendError(res, 404, kcError("PROVIDER_UNKNOWN", `No provider configured with id '${id}'.`));
    }
    const result = await checkProvider(provider);
    store.saveCheck(result);
    return sendJson(res, 200, { result });
  }

  sendError(res, 404, kcError("INTERNAL", `No route for ${req.method} ${url.pathname}.`));
}

/**
 * Schedules are plain CRUD over HTTP: nothing streams, and the runs they
 * produce reach the browser as ordinary conversations over the socket.
 */
async function handleSchedules(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  scheduler: Scheduler,
): Promise<void> {
  if (url.pathname === "/api/schedules" && req.method === "GET") {
    const id = url.searchParams.get("id");
    const runs = Number(url.searchParams.get("runs") ?? 10);
    const body: SchedulesResponse = { schedules: scheduler.list(id ?? undefined, runs) };
    return sendJson(res, 200, body);
  }

  if (url.pathname === "/api/schedules" && req.method === "POST") {
    const input = (await readJson(req)) as ScheduleInput;
    return sendJson(res, 201, { schedule: scheduler.create(input) });
  }

  const one = /^\/api\/schedules\/([^/]+)$/.exec(url.pathname);
  if (one && req.method === "PATCH") {
    const id = decodeURIComponent(one[1]!);
    const patch = (await readJson(req)) as Partial<ScheduleInput> & { status?: Schedule["status"] };
    return sendJson(res, 200, { schedule: scheduler.update(id, patch) });
  }
  if (one && req.method === "DELETE") {
    scheduler.delete(decodeURIComponent(one[1]!));
    return sendJson(res, 200, { ok: true });
  }

  const runMatch = /^\/api\/schedules\/([^/]+)\/run$/.exec(url.pathname);
  if (runMatch && req.method === "POST") {
    const run = await scheduler.runNow(decodeURIComponent(runMatch[1]!));
    return sendJson(res, 200, { run });
  }

  sendError(res, 404, kcError("INTERNAL", `No route for ${req.method} ${url.pathname}.`));
}

/** Rooms: CRUD plus the four verbs — say, hold, resume, stop. The page polls while a round runs. */
async function handleRooms(req: IncomingMessage, res: ServerResponse, url: URL, rooms: RoomManager): Promise<void> {
  if (url.pathname === "/api/rooms" && req.method === "GET") return sendJson(res, 200, { rooms: rooms.list() });
  if (url.pathname === "/api/rooms" && req.method === "POST") {
    const room = await rooms.create((await readJson(req)) as RoomInput);
    return sendJson(res, 201, { room });
  }

  const one = /^\/api\/rooms\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
  if (!one) return sendError(res, 404, kcError("INTERNAL", `No route for ${req.method} ${url.pathname}.`));
  const id = decodeURIComponent(one[1]!);
  const verb = one[2];

  if (!verb && req.method === "GET") return sendJson(res, 200, { room: rooms.get(id) });
  if (!verb && req.method === "DELETE") {
    rooms.delete(id);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== "POST") return sendError(res, 404, kcError("INTERNAL", `No route for ${req.method} ${url.pathname}.`));

  switch (verb) {
    case "say": {
      const body = (await readJson(req)) as { text?: unknown; cutIn?: unknown };
      await rooms.say(id, typeof body.text === "string" ? body.text : "", body.cutIn === true);
      break;
    }
    case "hold": {
      const body = (await readJson(req)) as { held?: unknown };
      rooms.hold(id, body.held === true);
      break;
    }
    case "resume":
      rooms.resume(id);
      break;
    case "reconnect":
      await rooms.reconnect(id);
      break;
    case "steer":
      rooms.steer(id, (await readJson(req)) as { topic?: unknown; rules?: unknown });
      break;
    case "stop":
      rooms.stop(id);
      break;
    default:
      return sendError(res, 404, kcError("INTERNAL", `No route for ${req.method} ${url.pathname}.`));
  }
  return sendJson(res, 200, { room: rooms.get(id) });
}

/**
 * The Files pane. Confined to the conversation's roots — its working
 * directory plus whatever `root_added` events say — by `files.ts`; here is
 * only the routing and the one response that is not JSON.
 */
async function handleFiles(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: Store,
  sessions: SessionManager,
): Promise<void> {
  const m = /^\/api\/sessions\/([^/]+)\/(files|file|raw|roots)$/.exec(url.pathname)!;
  const id = decodeURIComponent(m[1]!);
  const verb = m[2]!;
  const record = store.getSession(id);
  if (!record) return sendError(res, 404, kcError("SESSION_UNKNOWN", `No conversation with id '${id}'.`));
  const roots = collectRoots(record.cwd, store.eventsSince(id, 0));

  if (verb === "roots") {
    if (req.method === "GET") return sendJson(res, 200, { roots });
    if (req.method !== "POST" && req.method !== "DELETE") {
      return sendError(res, 404, kcError("INTERNAL", `No route for ${req.method} ${url.pathname}.`));
    }
    // Into the log, which needs the session live: a restored conversation has
    // no writer. Browsing works without one; changing the roots does not.
    const body = (await readJson(req)) as { path?: unknown };
    const path = await validateRoot(body.path);
    sessions.requireLive(id).setRoot(path, req.method === "POST");
    return sendJson(res, 200, { roots: collectRoots(record.cwd, store.eventsSince(id, 0)) });
  }

  if (req.method !== "GET") return sendError(res, 404, kcError("INTERNAL", `No route for ${req.method} ${url.pathname}.`));
  const root = url.searchParams.get("root") ?? record.cwd;
  const path = url.searchParams.get("path") ?? "";

  if (verb === "files") return sendJson(res, 200, await listDirectory(roots, root, path));
  if (verb === "file") return sendJson(res, 200, await readText(roots, root, path));

  const { file, mime } = await rawFile(roots, root, path);
  const { size } = statSync(file);
  res.writeHead(200, {
    "content-type": mime,
    "content-length": String(size),
    "x-content-type-options": "nosniff",
    // A unique origin for anything served raw: a file in a cloned repository
    // must not run as us if someone navigates to it directly.
    "content-security-policy": "sandbox",
    "content-disposition": "inline",
  });
  createReadStream(file)
    .on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    })
    .pipe(res);
}

function hostPlatform(): "darwin" | "linux" | "win32" | "other" {
  const p = process.platform;
  return p === "darwin" || p === "linux" || p === "win32" ? p : "other";
}

/** Reads a JSON request body, with a cap so a bad client cannot exhaust memory. */
async function readJson(req: IncomingMessage, limit = 64_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw kcError("CONFIG_INVALID", "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    throw kcError("CONFIG_INVALID", "Request body was not valid JSON.", { cause: String(err) });
  }
}

function serveStatic(res: ServerResponse, root: string, pathname: string): void {
  // Normalise before joining so "../" cannot escape the web root.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, safe);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, "index.html"); // SPA fallback
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  // A stream with no error listener throws on the event loop, and that is
  // fatal for the whole process — every running turn included. A file that
  // vanishes between the existsSync above and the read is enough.
  createReadStream(file)
    .on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    })
    .pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** A typed error already says whose fault it is; the status should agree. */
function statusFor(error: KcError): number {
  if (error.code.endsWith("_UNKNOWN")) return 404;
  if (error.code.endsWith("_INVALID")) return 400;
  return 500;
}

const sendError = (res: ServerResponse, status: number, error: KcError) =>
  sendJson(res, status, { error });
