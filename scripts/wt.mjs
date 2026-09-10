// Worktree helper: one directory per feature, removed once its PR is merged.
//
// Why a script rather than four documented commands: this repo rebase-merges,
// which rewrites the commits, so a merged branch is not an ancestor of `main`
// and `git branch --merged` reports nothing. Cleanup therefore has to ask
// GitHub whether the PR was merged, and that is enough steps to be skipped —
// three stale branches had already piled up before this existed.
//
// Usage:
//   npm run wt -- new <topic>     branch + worktree + install
//   npm run wt -- list            every worktree with its PR state
//   npm run wt -- done [topic]    remove a merged worktree and its branch
//   npm run wt -- prune [--yes]   sweep every merged worktree and branch

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Run a command, returning trimmed stdout. Throws with stderr attached. */
function run(command, args, opts = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", opts.quiet ? "pipe" : "inherit"],
    ...opts,
  }).trim();
}

/** Run a command, returning null instead of throwing. */
function tryRun(command, args, opts = {}) {
  try {
    return run(command, args, { quiet: true, ...opts });
  } catch {
    return null;
  }
}

const git = (args, opts) => run("git", args, opts);
const tryGit = (args, opts) => tryRun("git", args, opts);

/** Run a command with its output on screen — for anything slow, like install. */
const runLoud = (command, args, opts) =>
  execFileSync(command, args, { stdio: "inherit", ...opts });

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// --- repo layout -----------------------------------------------------------

/** Every worktree, main first, as git reports them. */
function worktrees() {
  const out = git(["worktree", "list", "--porcelain"], { quiet: true });
  return out
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const entry = { path: "", branch: null, detached: false };
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) entry.path = line.slice(9);
        else if (line.startsWith("branch ")) entry.branch = line.slice(7).replace("refs/heads/", "");
        else if (line === "detached") entry.detached = true;
      }
      return entry;
    });
}

const main = worktrees()[0];
const MAIN = main.path;
// Sibling of the main checkout, so npm workspace globs, `tsc -b` and vite
// never see a nested second copy of the tree.
const HOME_DIR = join(dirname(MAIN), `${basename(MAIN)}-worktrees`);
const pathFor = (topic) => join(HOME_DIR, topic);

// --- GitHub ----------------------------------------------------------------

const hasGh = tryRun("gh", ["--version"]) !== null;

/**
 * The PR state for a branch: "MERGED", "OPEN", "CLOSED", or null when there is
 * no PR, no `gh`, or no network. Null is never treated as merged.
 */
function prState(branch) {
  if (!hasGh) return null;
  // From the main checkout, so `gh` can resolve the repo wherever we were run.
  const out = tryRun("gh", ["pr", "view", branch, "--json", "state,number"], { cwd: MAIN });
  if (out === null) return null;
  try {
    const { state, number } = JSON.parse(out);
    return { state, number };
  } catch {
    return null;
  }
}

// --- new -------------------------------------------------------------------

function cmdNew(topic) {
  if (!topic) fail("Usage: npm run wt -- new <topic>");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(topic)) {
    fail(`"${topic}" is not a topic name. Use lowercase words joined by dashes.`);
  }

  const path = pathFor(topic);
  if (existsSync(path)) fail(`${path} already exists. Pick another name, or \`wt done ${topic}\`.`);
  if (tryGit(["rev-parse", "--verify", `refs/heads/${topic}`]) !== null) {
    fail(`Branch ${topic} already exists.`);
  }

  // Branch from the remote's main, not a local one that may be behind.
  let base = "main";
  if (tryGit(["-C", MAIN, "fetch", "origin", "main"]) === null) {
    console.log("  Could not reach origin — branching from local main.");
  } else {
    base = "origin/main";
  }

  console.log(`\n  Creating ${path} on ${base}`);
  git(["-C", MAIN, "worktree", "add", "-b", topic, path, base]);

  console.log("\n  Installing dependencies (a worktree has its own node_modules)");
  runLoud("npm", ["install"], { cwd: path });
  // spike/ is installed separately: it holds the mock agent's copy of the ACP
  // SDK, and the server suite spawns it.
  if (existsSync(join(path, "spike", "package.json"))) {
    runLoud("npm", ["install"], { cwd: join(path, "spike") });
  }

  console.log(`\n  Ready.\n\n    cd ${path}\n`);
  console.log("  Only run one dev server at a time — they share ports 4711/5173");
  console.log("  and one database. Stop the other before `npm run dev` here.\n");
}

// --- list ------------------------------------------------------------------

function cmdList() {
  const all = worktrees();
  console.log("");
  for (const [index, tree] of all.entries()) {
    const label = tree.branch ?? (tree.detached ? "(detached)" : "(no branch)");
    const pr = index === 0 || !tree.branch ? null : prState(tree.branch);
    const state = pr ? `PR #${pr.number} ${pr.state.toLowerCase()}` : hasGh ? "no PR" : "";
    const tag = index === 0 ? "main checkout" : state;
    console.log(`  ${label.padEnd(28)} ${tag.padEnd(20)} ${tree.path}`);
  }
  console.log("");
}

// --- done ------------------------------------------------------------------

/** Why this worktree cannot be removed yet, or null if it can. */
function blockers(tree) {
  const reasons = [];

  const dirty = tryGit(["-C", tree.path, "status", "--porcelain"]);
  if (dirty === null) reasons.push("could not read its status");
  else if (dirty !== "") reasons.push("has uncommitted changes");

  const pr = prState(tree.branch);
  if (pr === null) reasons.push(hasGh ? "has no PR (or GitHub is unreachable)" : "state is unknown — `gh` is not installed");
  else if (pr.state !== "MERGED") reasons.push(`PR #${pr.number} is ${pr.state.toLowerCase()}, not merged`);

  const remote = `refs/remotes/origin/${tree.branch}`;
  if (tryGit(["-C", MAIN, "rev-parse", "--verify", remote]) !== null) {
    const ahead = tryGit(["-C", MAIN, "log", "--oneline", `origin/${tree.branch}..${tree.branch}`]);
    if (ahead) reasons.push(`has ${ahead.split("\n").length} commit(s) that were never pushed`);
  }

  return reasons.length > 0 ? reasons : null;
}

function remove(tree, { force }) {
  git(["-C", MAIN, "worktree", "remove", ...(force ? ["--force"] : []), tree.path]);
  git(["-C", MAIN, "branch", "-D", tree.branch]);
  console.log(`  Removed ${tree.branch}`);
}

function cmdDone(topic, { force }) {
  const cwd = process.cwd();
  const all = worktrees();

  const tree = topic
    ? all.find((t) => t.branch === topic)
    : all.slice(1).find((t) => resolve(cwd).startsWith(resolve(t.path)));

  if (!tree) {
    fail(topic ? `No worktree for ${topic}. \`npm run wt -- list\`.` : "Not inside a worktree. Name one: `npm run wt -- done <topic>`.");
  }
  if (tree.path === MAIN) fail("That is the main checkout, not a worktree.");
  if (resolve(cwd).startsWith(resolve(tree.path))) {
    fail(`You are inside it. Run \`cd ${MAIN}\` first, then \`npm run wt -- done ${tree.branch}\`.`);
  }

  const reasons = blockers(tree);
  if (reasons && !force) {
    fail(`${tree.branch} ${reasons.join(", and ")}.\n  Pass --force to remove it anyway — the work is discarded.`);
  }

  console.log("");
  remove(tree, { force });
  git(["-C", MAIN, "fetch", "--prune"]);
  console.log("  Pruned stale remote branches.\n");
}

// --- prune -----------------------------------------------------------------

function cmdPrune({ confirmed }) {
  const all = worktrees().slice(1);
  const removable = [];
  const kept = [];

  for (const tree of all) {
    if (!tree.branch) continue;
    const reasons = blockers(tree);
    if (reasons) kept.push([tree, reasons]);
    else removable.push(tree);
  }

  // Branches whose PR is merged but whose worktree is already gone — the pile
  // that accumulates from before this script, or from a manual merge.
  const inTree = new Set(all.map((t) => t.branch));
  const current = tryGit(["-C", MAIN, "branch", "--show-current"]);
  const orphans = git(["-C", MAIN, "branch", "--format=%(refname:short)"], { quiet: true })
    .split("\n")
    .filter((b) => b && b !== current && !inTree.has(b))
    .filter((b) => prState(b)?.state === "MERGED");

  if (removable.length === 0 && orphans.length === 0) {
    console.log("\n  Nothing to prune.\n");
    for (const [tree, reasons] of kept) console.log(`  keeping ${tree.branch} — ${reasons.join(", and ")}`);
    if (kept.length > 0) console.log("");
    return;
  }

  console.log("");
  for (const tree of removable) console.log(`  worktree  ${tree.branch}  ${tree.path}`);
  for (const branch of orphans) console.log(`  branch    ${branch}`);
  for (const [tree, reasons] of kept) console.log(`  keeping   ${tree.branch} — ${reasons.join(", and ")}`);

  if (!confirmed) {
    console.log("\n  Nothing removed. Re-run with --yes to remove the above.\n");
    return;
  }

  console.log("");
  for (const tree of removable) remove(tree, { force: false });
  for (const branch of orphans) {
    git(["-C", MAIN, "branch", "-D", branch]);
    console.log(`  Removed ${branch}`);
  }
  git(["-C", MAIN, "fetch", "--prune"]);
  console.log("  Pruned stale remote branches.\n");
}

// --- dispatch --------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const [positional] = rest.filter((a) => !a.startsWith("--"));

switch (command) {
  case "new":
    cmdNew(positional);
    break;
  case "list":
    cmdList();
    break;
  case "done":
    cmdDone(positional, { force: flags.has("--force") });
    break;
  case "prune":
    cmdPrune({ confirmed: flags.has("--yes") });
    break;
  default:
    fail(
      "Usage:\n" +
        "    npm run wt -- new <topic>     branch + worktree + install\n" +
        "    npm run wt -- list            every worktree with its PR state\n" +
        "    npm run wt -- done [topic]    remove a merged worktree and its branch\n" +
        "    npm run wt -- prune [--yes]   sweep every merged worktree and branch",
    );
}
