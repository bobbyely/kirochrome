// Development runner: watches and reloads everything, from one command.
//
// Three processes rather than one:
//   tsc -b -w    rebuilds shared and server on change
//   node --watch restarts the server when its build output changes
//   vite         serves the UI with hot module replacement
//
// Written by hand rather than pulling in a process runner: it is ~50 lines and
// keeps the dependency list honest.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const COLOURS = { shared: "\x1b[35m", server: "\x1b[36m", web: "\x1b[32m" };
const RESET = "\x1b[0m";

const children = [];
let shuttingDown = false;

function run(name, command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: opts.cwd ?? root,
    // KIROCHROME_DEV is what makes the server trust Vite's origin. Only the dev
    // runner sets it: a built install must not accept requests from whatever
    // else the user happens to be serving on 5173.
    env: { ...process.env, FORCE_COLOR: "1", KIROCHROME_DEV: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so shutting down takes the whole tree with it.
    detached: process.platform !== "win32",
  });

  const prefix = `${COLOURS[name] ?? ""}[${name}]${RESET}`;
  const forward = (stream, out) => {
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) out.write(`${prefix} ${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`${prefix} exited (${signal ?? code}) — stopping everything`);
    shutdown();
  });

  children.push(child);
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => process.exit(0), 300).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("shared", "npx", ["tsc", "-b", "-w", "--preserveWatchOutput", "packages/shared", "packages/server"]);
run("server", "node", [
  "--watch",
  "--watch-preserve-output",
  "--no-warnings=ExperimentalWarning",
  "packages/server/dist/index.js",
]);
run("web", "npx", ["vite"], { cwd: join(root, "packages", "web") });

console.log("\n  UI with hot reload:  http://127.0.0.1:5173");
console.log("  API and WebSocket:   http://127.0.0.1:4711  (proxied by Vite)\n");
