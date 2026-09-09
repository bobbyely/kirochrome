import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { kcError, type KcError } from "@kirochrome/shared";
import type { ProviderView } from "@kirochrome/shared";
import { checkProvider } from "./check.js";
import { exportFilename, toMarkdown } from "./export.js";
import { loadConfig } from "./config.js";
import { SessionManager } from "./sessionManager.js";
import { Store } from "./store.js";
import { attachWebSocket } from "./ws.js";

const HOST = "127.0.0.1";

/**
 * Any page in the user's browser can send requests to a local server, so we
 * check Origin explicitly rather than relying on binding to loopback.
 */
function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // same-origin fetch or curl
  const allowed = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    "http://localhost:5173", // vite dev server
    "http://127.0.0.1:5173",
  ]);
  return allowed.has(origin);
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

  const server = createServer(async (req, res) => {
    if (!originAllowed(req, port)) {
      return sendError(res, 403, kcError("INTERNAL", "Origin not allowed."));
    }

    const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, store);
      if (webRoot) return serveStatic(res, webRoot, url.pathname);
      return sendJson(res, 404, { error: kcError("INTERNAL", "No web build. Run `npm run build`.") });
    } catch (err) {
      const error: KcError =
        typeof err === "object" && err !== null && "code" in err
          ? (err as KcError)
          : kcError("INTERNAL", "Unhandled server error.", { cause: String(err) });
      sendError(res, 500, error);
    }
  });

  attachWebSocket(server, sessions, (req) => originAllowed(req, port));

  server.listen(port, HOST, () => {
    console.log(`KiroChrome on http://${HOST}:${port}`);
  });

  // Agents are child processes; leaving them behind is the orphan bug we
  // designed against, so tear them down on the way out.
  const shutdown = () => {
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
    return sendJson(res, 200, { providers });
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

function serveStatic(res: ServerResponse, root: string, pathname: string): void {
  // Normalise before joining so "../" cannot escape the web root.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, safe);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, "index.html"); // SPA fallback
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const sendError = (res: ServerResponse, status: number, error: KcError) =>
  sendJson(res, status, { error });
