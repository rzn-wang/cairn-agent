// Install self-healing — the pieces of an installation that a fresh clone
// silently loses because they live outside version control (.git/hooks, the
// store dirs). settings.json hooks ARE versioned, so if session_start runs at
// all, everything else can be healed from inside it; `cairn init` reuses these
// for its apply phase.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDir, derivedKey, log, repoRoot } from "./store.mjs";

export const POST_COMMIT_LINE = `node "$(git rev-parse --show-toplevel)/scripts/cairn/cairn.mjs" mine HEAD --detach || true`;

// .git may be a file (worktree); --git-path resolves hooks/ either way.
function hooksDir(cwd) {
  const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  return resolve(cwd, out);
}

export function postCommitChained(cwd) {
  try {
    const pc = join(hooksDir(cwd), "post-commit");
    return existsSync(pc) && readFileSync(pc, "utf8").includes("scripts/cairn");
  } catch {
    return false;
  }
}

// Chain the miner onto post-commit, preserving any prior hook body.
// Returns true when it changed something.
export function chainPostCommit(cwd) {
  if (postCommitChained(cwd)) return false;
  const pc = join(hooksDir(cwd), "post-commit");
  const prior = existsSync(pc) ? readFileSync(pc, "utf8") : "";
  const body = prior
    ? prior.replace(/\s*$/, "\n") + POST_COMMIT_LINE + "\n"
    : `#!/bin/sh\n${POST_COMMIT_LINE}\n`;
  writeFileSync(pc, body, { mode: 0o755 });
  return true;
}

export function ensureGitignore(cwd) {
  const gi = join(repoRoot(cwd), ".gitignore");
  const text = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  // learnings.jsonl and config.json are committed (shared team knowledge and
  // the pinned repo identity); the rest of the store stays per-machine. Key
  // idempotency on the config negation so installs predating it get re-scoped.
  if (text.includes("!.claude/cairn/config.json")) return false;
  const block = text.includes("!.claude/cairn/learnings.jsonl")
    ? "!.claude/cairn/config.json\n"
    : "# Cairn store is per-machine; learnings.jsonl + config.json are shared (committed).\n" +
      ".claude/cairn/*\n" +
      "!.claude/cairn/learnings.jsonl\n" +
      "!.claude/cairn/config.json\n";
  appendFileSync(gi, (text.endsWith("\n") || !text ? "" : "\n") + block);
  return true;
}

// Pin the repo identity in a committed file. Without this the key is derived
// from the origin URL, which differs between a fork, an ssh vs https clone and
// an agent sandbox behind a git proxy — each of which then reads an empty store
// out of a learnings.jsonl that travelled with the repo.
export function ensureConfig(cwd) {
  const p = join(dataDir(cwd), "config.json");
  if (existsSync(p)) return false;
  writeFileSync(p, JSON.stringify({ repo_key: derivedKey(cwd) }, null, 2) + "\n");
  return true;
}

// Heal what a fresh clone loses; every step is idempotent and best-effort.
// Skipped entirely under CAIRN_DIR — an overridden store means an isolated
// run (selftest) that must not touch the real repo.
export function selfHeal(cwd) {
  if (process.env.CAIRN_DIR) return [];
  const healed = [];
  try {
    dataDir(cwd);
  } catch {
    /* store dir creation is best-effort */
  }
  try {
    if (chainPostCommit(cwd)) healed.push("post-commit chained");
  } catch {
    /* no .git */
  }
  try {
    if (ensureGitignore(cwd)) healed.push(".gitignore entry");
  } catch {
    /* read-only tree */
  }
  try {
    if (ensureConfig(cwd)) healed.push("config.json repo_key pinned");
  } catch {
    /* read-only tree */
  }
  if (healed.length) log(cwd, `self-heal: ${healed.join(", ")}`);
  return healed;
}
