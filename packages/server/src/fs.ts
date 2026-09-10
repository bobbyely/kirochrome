import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";

/**
 * The client half of ACP's filesystem methods.
 *
 * We advertise `fs.readTextFile` and `fs.writeTextFile`, so agents are entitled
 * to call these; an unimplemented method would fail their file operations with
 * a bare "method not found".
 *
 * No sandboxing beyond requiring an absolute path: the agent is a local process
 * running as the user and can already read and write anything they can. Adding
 * a false boundary here would suggest a guarantee we cannot make.
 */

export async function readTextFile(params: {
  path: string;
  line?: number | null;
  limit?: number | null;
}): Promise<{ content: string }> {
  requireAbsolute(params.path);

  let content: string;
  try {
    content = await readFile(params.path, "utf8");
  } catch (err) {
    throw fsError(`Could not read ${params.path}`, err);
  }

  // `line` is 1-based and both are optional; slicing only when asked keeps the
  // common whole-file read allocation-free.
  if (params.line == null && params.limit == null) return { content };

  const lines = content.split("\n");
  const from = Math.max(0, (params.line ?? 1) - 1);
  const to = params.limit == null ? lines.length : from + params.limit;
  return { content: lines.slice(from, to).join("\n") };
}

export async function writeTextFile(params: { path: string; content: string }): Promise<void> {
  requireAbsolute(params.path);
  try {
    // Agents write files into directories they have just decided to create.
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, "utf8");
  } catch (err) {
    throw fsError(`Could not write ${params.path}`, err);
  }
}

function requireAbsolute(path: string): void {
  if (!isAbsolute(path)) {
    throw RequestError.invalidParams(undefined, `path must be absolute, got '${path}'`);
  }
}

function fsError(message: string, err: unknown): RequestError {
  const code = (err as NodeJS.ErrnoException)?.code;
  return RequestError.internalError({ reason: `${message}: ${code ?? String(err)}` });
}
