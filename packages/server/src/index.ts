import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { startServer } from "./http.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "..", "..", "web", "dist");
const port = Number(process.env.KIROCHROME_PORT ?? 4711);

startServer(port, existsSync(join(webDist, "index.html")) ? webDist : null);
