// Cairn store — JSONL files under <toplevel>/.claude/cairn/ (docs/CAIRN.md).
// Zero deps; every write is an append or a whole-file rewrite of a small JSONL.
// Design contract: fail open — callers wrap in try/catch and degrade to nothing.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { foldLearnings, learningKey, sameFact, tokens } from "./rank.mjs";
import { clean } from "./slop.mjs";
import { symbolBaselines } from "./graph/symbols.mjs";

export function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"], // callers handle failure; git's own "fatal:" must not leak into output
  }).trim();
}

// Cached per folder: a hook asks this many times, and each ask was a git process (≈10 ms).
const roots = new Map();
export function repoRoot(cwd = process.cwd()) {
  if (roots.has(cwd)) return roots.get(cwd);
  let r = cwd;
  try {
    r = git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    /* not a repo: the folder itself */
  }
  roots.set(cwd, r);
  return r;
}

export function repoBranch(cwd = process.cwd()) {
  try {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  } catch {
    return "unknown";
  }
}

// Identity of the repo this store belongs to. Prefers the COMMITTED
// .claude/cairn/config.json, because deriving it from the origin URL makes the
// key environment-dependent: a fork, a mirror, an ssh-vs-https clone or an
// agent sandbox behind a git proxy all produce a different key and silently
// hide the shared learnings.jsonl that ships inside the repo.
// Falls back to normalized origin URL (lowercase host, no .git, ssh form ->
// host/org/repo), then path:<sha256 of toplevel>.
export function configuredKey(cwd = process.cwd()) {
  try {
    const raw = readFileSync(join(repoRoot(cwd), ".claude", "cairn", "config.json"), "utf8");
    const key = JSON.parse(raw).repo_key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

export function derivedKey(cwd = process.cwd()) {
  try {
    let url = git(["remote", "get-url", "origin"], cwd);
    url = url.replace(/\.git$/, "");
    let m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
    if (!m) m = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(url); // git@host:org/repo
    if (m) return `${m[1].toLowerCase()}/${m[2]}`;
  } catch {
    /* no remote */
  }
  return "path:" + createHash("sha256").update(repoRoot(cwd)).digest("hex").slice(0, 16);
}

export function repoKey(cwd = process.cwd()) {
  return configuredKey(cwd) || derivedKey(cwd);
}

// Repo-relative paths currently in play: uncommitted edits first, then the last
// few commits. A fresh clone has no checkpoints, so without this the seed has no
// relevance signal at all and falls back to "whatever was mined most recently".
export function recentFiles(cwd = process.cwd(), limit = 40) {
  const out = new Set();
  for (const args of [
    ["diff", "--name-only", "HEAD"],
    ["diff", "--name-only", "HEAD~3", "HEAD"],
  ]) {
    try {
      for (const f of git(args, cwd).split("\n")) if (f.trim()) out.add(f.trim());
    } catch {
      /* shallow clone, root commit, or no HEAD yet */
    }
    if (out.size >= limit) break;
  }
  return [...out].slice(0, limit);
}

// Per-path churn over the last `commits` commits, 0..1 (1 = touched by every
// one). Ranking uses it to discount the stale penalty: a file that changes
// constantly says almost nothing by changing again, so it must not hold a
// permanent penalty over every fact that cites it. Empty map on any git failure,
// which degrades to the old flat penalty.
export function churnRates(cwd = process.cwd(), commits = 20) {
  const counts = new Map();
  let n = 0;
  try {
    const out = git(["log", `-n${commits}`, "--name-only", "--format=%H"], cwd);
    for (const block of out.split(/^(?=[0-9a-f]{40}$)/m)) {
      if (!block.trim()) continue;
      n++;
      // line 0 is the hash, then a blank line, then the paths
      const files = block
        .split("\n")
        .slice(1)
        .filter((l) => l.trim());
      for (const f of new Set(files)) counts.set(f, (counts.get(f) || 0) + 1);
    }
  } catch {
    return new Map();
  }
  if (!n) return new Map();
  const rates = new Map();
  for (const [f, c] of counts) rates.set(f, c / n);
  return rates;
}

export function dataDir(cwd = process.cwd()) {
  const dir = process.env.CAIRN_DIR || join(repoRoot(cwd), ".claude", "cairn");
  for (const sub of ["", "state", "log", "inflight"]) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

export function log(cwd, msg) {
  try {
    appendFileSync(join(dataDir(cwd), "log", "cairn.log"), `${now()} ${msg}\n`);
  } catch {
    /* logging must never throw */
  }
}

export function contentHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return rows;
}

// One write syscall per line (O_APPEND): concurrent sessions can interleave
// lines but never tear one below ~4KB, and readJsonl skips anything corrupt —
// torn writes are self-healing by construction. Keep rows small (bodies ≤1500).
function appendJsonl(path, row) {
  appendFileSync(path, JSON.stringify(row) + "\n");
}

// Small local JSONL logs in the store dir (jobs, messages): append-only, torn lines skipped.
export function readRows(cwd, file) {
  return readJsonl(join(dataDir(cwd), file));
}
export function appendRow(cwd, file, row) {
  appendJsonl(join(dataDir(cwd), file), row);
}
export function rewriteRows(cwd, file, rows) {
  rewriteJsonl(join(dataDir(cwd), file), rows);
}

function rewriteJsonl(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

// --- checkpoints: { repo_key, session_id, branch, created_at, trigger, engine,
//                    task, status, body_md, files_touched } ---
export function readCheckpoints(cwd) {
  return readJsonl(join(dataDir(cwd), "checkpoints.jsonl"));
}
export function addCheckpoint(cwd, row) {
  appendJsonl(join(dataDir(cwd), "checkpoints.jsonl"), row);
}
export function writeCheckpoints(cwd, rows) {
  rewriteJsonl(join(dataDir(cwd), "checkpoints.jsonl"), rows);
}
export function latestCheckpoint(cwd, { branch, sessionId } = {}) {
  const all = readCheckpoints(cwd).filter((c) => c.repo_key === repoKey(cwd));
  const pool = sessionId ? all.filter((c) => c.session_id === sessionId) : all;
  const same = branch ? pool.filter((c) => c.branch === branch) : pool;
  const pick = (rows) => rows[rows.length - 1];
  return same.length ? pick(same) : pick(pool);
}

// --- learnings: { id, key, repo_key, text, source, refs, ref_hashes,
//                  created_at, last_verified_at, status }
//     control rows: { ctl: "retire"|"verify", key, at, ... } ---
// The file is APPEND-ONLY in normal operation (it is committed and merge=union,
// so a rewrite racing another process's append silently loses data). Edits to a
// fact — retiring it, re-verifying it — are appended as control rows and folded
// in on read; only the explicit `gc --compact` ever rewrites.
const LEARN = "learnings.jsonl";
export function readLearnings(cwd) {
  return readJsonl(join(dataDir(cwd), LEARN));
}
export function writeLearnings(cwd, rows) {
  rewriteJsonl(join(dataDir(cwd), LEARN), rows);
}
function learnPath(cwd) {
  return join(dataDir(cwd), LEARN);
}

function hashRefs(cwd, refs) {
  const out = {};
  for (const r of new Set(refs.map((x) => String(x).split("#")[0]))) {
    try {
      out[r] = contentHash(join(repoRoot(cwd), r));
    } catch {
      /* missing file, directory (EISDIR), unreadable: no baseline for this ref */
    }
  }
  return out;
}

// Fold the raw file into current facts, then derive staleness by comparing each
// fact's recorded ref hashes against the files on disk *now*. Deriving it beats
// the old PostToolUse write-back: no per-edit subprocess, no read-modify-write
// race, and no drift when an edit arrives through a tool the hook didn't match.
export function activeLearnings(cwd, { stale = true } = {}) {
  const rows = foldLearnings(readLearnings(cwd));
  if (!stale) return rows;
  return markStale(rows, repoRoot(cwd));
}

// Flag facts whose cited file no longer exists (shared with the graph's learning mirror).
export function markStale(rows, root) {
  const cache = new Map();
  for (const l of rows) {
    const changed = [];
    for (const [ref, was] of Object.entries(l.ref_hashes || {})) {
      // Only a cited file that is GONE flags the fact. "Changed since" flagged 84%
      // of facts in a tree this busy and was acted on 6 times (review, 2026-10-06):
      // an edit to a file says almost nothing about one sentence describing it.
      // So existence is all that's checked: a stat, not a read and hash of the file.
      if (!cache.has(ref)) cache.set(ref, existsSync(join(root, ref)));
      if (was && !cache.get(ref)) changed.push(ref);
    }
    l.stale = changed.length > 0;
    l.stale_refs = changed;
  }
  return rows;
}

// Records a fact unless an equivalent one is already stored. Returns
// { duplicate: true, of } instead of appending a near-copy — the post-commit
// miner re-derives the same three facts from every commit over the same code.
export function addLearning(cwd, { text, source, refs = [] }) {
  text = clean(text); // AI filler out before it becomes memory (lib/slop.mjs)
  const existing = activeLearnings(cwd, { stale: false });
  const key = learningKey(text);
  const toks = tokens(text);
  const dup = existing.find(
    (l) => l.keys?.has(key) || l.key === key || sameFact(toks, l.tokens || tokens(l.text)),
  );
  if (dup) return { duplicate: true, of: dup };

  const raw = readLearnings(cwd);
  const ids = raw.map((r) => r.id).filter((n) => Number.isFinite(n));
  const row = {
    id: ids.length ? Math.max(...ids) + 1 : 1,
    key,
    repo_key: repoKey(cwd),
    text,
    source,
    refs,
    ref_hashes: hashRefs(cwd, refs),
    ...symRefs(cwd, refs, text),
    created_at: now(),
    last_verified_at: now(),
    status: "verified",
  };
  appendJsonl(learnPath(cwd), row);
  return row;
}

// Everything recallable. Staleness is a flag on the row, never an exclusion:
// "someone edited world.ts" is not "this fact stopped being true", and the
// reading agent is better placed to judge than a content hash is.
export function recallable(cwd) {
  return activeLearnings(cwd);
}

// Re-baseline a fact's refs: clears derived staleness and bumps last_verified_at.
export function verifyLearning(cwd, key) {
  const row = activeLearnings(cwd, { stale: false }).find((l) => l.keys?.has(key) || l.key === key);
  if (!row) return null;
  appendJsonl(learnPath(cwd), {
    ctl: "verify",
    key: row.key,
    at: now(),
    ref_hashes: hashRefs(cwd, row.refs || []),
    ...symRefs(cwd, row.refs || [], row.text),
  });
  return row;
}

// The definition hashes of the symbols a fact cites (`path#Name`, or a backticked name defined in a cited file),
// so the graph can later say "renamed" or "removed" (lib/graph/symbols.mjs). Omitted when there are none.
function symRefs(cwd, refs, text) {
  try {
    const sym = symbolBaselines(repoRoot(cwd), refs, text);
    return Object.keys(sym).length ? { sym_refs: sym } : {};
  } catch {
    return {};
  }
}

// Retire a fact for good (the only way a learning ever leaves recall).
export function retireLearning(cwd, key, reason) {
  const row = activeLearnings(cwd, { stale: false }).find((l) => l.keys?.has(key) || l.key === key);
  if (!row) return null;
  appendJsonl(learnPath(cwd), { ctl: "retire", key: row.key, at: now(), reason: reason || "" });
  return row;
}

// --- in-flight distill markers, one per session (inflight/<session>.json): the
//     Stop hook skips while its own session's distill runs, and session_start
//     waits briefly while any fresh marker exists so a just-killed session's
//     checkpoint can land before the seed is built. One shared marker used to let
//     one session's distill make another skip its own (review, 2026-10-06). ---
export function markerPath(cwd, sessionId = "unknown") {
  return join(dataDir(cwd), "inflight", `${String(sessionId).replace(/[^\w-]/g, "_")}.json`);
}
export function setInflight(cwd, sessionId) {
  writeFileSync(markerPath(cwd, sessionId), JSON.stringify({ at: now() }));
}
export function clearInflight(cwd, sessionId) {
  try {
    rmSync(markerPath(cwd, sessionId));
  } catch {
    /* already gone */
  }
}
// Age of this session's marker, or with no session the youngest of any; null if none.
export function inflightAgeMs(cwd, sessionId) {
  const ageOf = (p) => {
    try {
      return Date.now() - Date.parse(JSON.parse(readFileSync(p, "utf8")).at);
    } catch {
      return null;
    }
  };
  if (sessionId) return ageOf(markerPath(cwd, sessionId));
  let best = null;
  try {
    const dir = join(dataDir(cwd), "inflight");
    for (const f of readdirSync(dir)) {
      const a = ageOf(join(dir, f));
      if (a !== null && (best === null || a < best)) best = a;
    }
  } catch {
    /* no markers */
  }
  return best;
}

// --- per-session state: { prompts_seen, last_checkpoint_line } ---
export function readState(cwd, sessionId) {
  const p = join(dataDir(cwd), "state", `${sessionId}.json`);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}
export function writeState(cwd, sessionId, state) {
  writeFileSync(join(dataDir(cwd), "state", `${sessionId}.json`), JSON.stringify(state));
}
// Every session's state, for the live-activity board. Each file is written only
// by its own session, so reading them all never races a writer into a torn read
// that matters: a half-written file just fails to parse and is skipped.
export function readAllStates(cwd) {
  const dir = join(dataDir(cwd), "state");
  const out = [];
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f === "distill-inflight.json") continue;
    try {
      out.push({ sessionId: f.slice(0, -5), state: JSON.parse(readFileSync(join(dir, f), "utf8")) });
    } catch {
      /* mid-write or corrupt: skip */
    }
  }
  return out;
}
