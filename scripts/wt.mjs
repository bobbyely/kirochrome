// Worktree helper: only the two things plain git cannot do tidily.
//
// Everything else in this workflow is a documented git command — see the pull
// request section of AGENTS.md. These two are here because:
//
//   new    a fresh worktree needs an install in `spike/` as well as its own,
//          and without it the server suite fails in a way that reads as a
//          broken checkout rather than a missing dependency.
//   prune  we rebase-merge, which rewrites the commits, so a merged branch is
//          never an ancestor of `main` and `git branch --merged` reports
//          nothing. Merged-ness has to come from GitHub, across every branch
//          at once.
//
// Usage:
//   npm run wt -- new <topic>     branch + worktree + install
//   npm run wt -- prune [--yes]   remove every merged worktree and branch

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
      const entry = { path: "", branch: null };
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) entry.path = line.slice(9);
        else if (line.startsWith("branch ")) entry.branch = line.slice(7).replace("refs/heads/", "");
      }
      return entry;
    });
}

const MAIN = worktrees()[0].path;
// Sibling of the main checkout, so the npm workspace glob, `tsc -b` and vite
// never see a nested second copy of the tree.
const HOME_DIR = join(dirname(MAIN), `${basename(MAIN)}-worktrees`);

// --- GitHub ----------------------------------------------------------------

/**
 * The PR for a branch, or null when there is no PR, no `gh`, or no network.
 * Null is never treated as merged.
 */
function pullRequest(branch) {
  // From the main checkout, so `gh` can resolve the repo wherever we were run.
  const out = tryRun("gh", ["pr", "view", branch, "--json", "state,number"], { cwd: MAIN });
  if (out === null) return null;
  try {
    return JSON.parse(out);
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

  const path = join(HOME_DIR, topic);
  if (existsSync(path)) fail(`${path} already exists.`);
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

// --- prune -----------------------------------------------------------------

/** Why this branch cannot be deleted yet, or null if it can. */
function blockers(branch, path) {
  const reasons = [];

  if (path !== undefined) {
    const dirty = tryGit(["-C", path, "status", "--porcelain"]);
    if (dirty === null) reasons.push("could not be read");
    else if (dirty !== "") reasons.push("has uncommitted changes");
  }

  const pr = pullRequest(branch);
  if (pr === null) reasons.push("has no PR, or GitHub is unreachable");
  else if (pr.state !== "MERGED") reasons.push(`PR #${pr.number} is ${pr.state.toLowerCase()}`);

  // A merged PR does not mean every local commit reached it.
  if (tryGit(["-C", MAIN, "rev-parse", "--verify", `refs/remotes/origin/${branch}`]) !== null) {
    const ahead = tryGit(["-C", MAIN, "log", "--oneline", `origin/${branch}..${branch}`]);
    if (ahead) reasons.push(`has ${ahead.split("\n").length} unpushed commit(s)`);
  }

  return reasons.length > 0 ? reasons : null;
}

function cmdPrune({ confirmed }) {
  const all = worktrees();
  const trees = new Map(
    all
      .slice(1)
      .filter((tree) => tree.branch)
      .map((tree) => [tree.branch, tree.path]),
  );
  // Never consider the branch we are standing on, nor the main checkout's —
  // which is not the same branch when prune is run from inside a worktree.
  const protectedBranches = new Set([all[0].branch, tryGit(["branch", "--show-current"])]);
  const branches = git(["-C", MAIN, "branch", "--format=%(refname:short)"], { quiet: true }).split("\n");

  const removable = [];
  const kept = [];
  for (const branch of branches) {
    if (!branch || protectedBranches.has(branch)) continue;
    const reasons = blockers(branch, trees.get(branch));
    if (reasons) kept.push([branch, reasons]);
    else removable.push(branch);
  }

  console.log("");
  for (const branch of removable) {
    const path = trees.get(branch);
    console.log(`  merged   ${branch}${path === undefined ? "" : `  ${path}`}`);
  }
  for (const [branch, reasons] of kept) console.log(`  keeping  ${branch} — ${reasons.join(", and ")}`);

  if (removable.length === 0) {
    console.log("\n  Nothing to prune.\n");
    return;
  }
  if (!confirmed) {
    console.log("\n  Nothing removed. Re-run with --yes to remove the above.\n");
    return;
  }

  console.log("");
  for (const branch of removable) {
    const path = trees.get(branch);
    if (path !== undefined) git(["-C", MAIN, "worktree", "remove", path]);
    git(["-C", MAIN, "branch", "-D", branch]);
    console.log(`  Removed ${branch}`);
  }
  // `gh pr merge --delete-branch` cannot clear a remote-tracking ref.
  git(["-C", MAIN, "fetch", "--prune"]);
  console.log("  Pruned stale remote branches.\n");
}

// --- dispatch --------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const [positional] = rest.filter((arg) => !arg.startsWith("--"));

if (command === "new") cmdNew(positional);
else if (command === "prune") cmdPrune({ confirmed: rest.includes("--yes") });
else {
  fail(
    "Usage:\n" +
      "    npm run wt -- new <topic>     branch + worktree + install\n" +
      "    npm run wt -- prune [--yes]   remove every merged worktree and branch\n\n" +
      "  Everything else is plain git: `git worktree list`, `git worktree remove`.\n" +
      "  See the pull request section of AGENTS.md.",
  );
}
