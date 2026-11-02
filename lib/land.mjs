// `cairn land <worktree> [files...]`: bring a worker's changes from a git worktree onto the main tree by a three-way
// merge per file, never by copying (docs/WORKING.md, "Landing work from a worktree"). Commit 3ab2ca4 copied a
// worker's docs/design/systems.md over main and reverted rows other sessions had added since the worker's base.
//
// For each file: base is the blob at the merge-base of main's HEAD and the worktree's HEAD, ours is main's working
// copy (other sessions' uncommitted edits included), theirs is the worktree's working copy. All or nothing: if any
// file conflicts, is held by another open session, or is a case a merge can't settle, nothing is written. Never
// stages and never commits. Each landed file goes on this session's live board, as an edit would.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ago, otherEditors, touch, who } from "./activity.mjs";

const HOLD_MS = 3600000; // the same hour the PreToolUse hold uses
const SKIP = /^\.claude\/cairn\//; // the store is union-merged by git, and a worktree's copy is never the truth

function git(dir, args, { buffer = false } = {}) {
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: buffer ? "buffer" : "utf8",
    maxBuffer: 64 << 20,
    windowsHide: true,
  });
  return { ok: r.status === 0, out: r.stdout, err: String(r.stderr || "").trim(), status: r.status };
}

const same = (a, b) => (a === null ? b === null : b !== null && a.equals(b));
const binary = (b) => b !== null && b.subarray(0, 8000).includes(0);
const norm = (p) => resolve(p).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();

function blob(dir, rev, path) {
  const r = git(dir, ["cat-file", "blob", `${rev}:${path}`], { buffer: true });
  return r.ok ? r.out : null;
}
const fileAt = (root, path) => (existsSync(join(root, path)) ? readFileSync(join(root, path)) : null);

// The first conflict block of a merge-file output, for the report.
function firstConflict(text, max = 24) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.startsWith("<<<<<<< "));
  if (i < 0) return "";
  const j = lines.findIndex((l, k) => k > i && l.startsWith(">>>>>>> "));
  const block = lines.slice(i, j < 0 ? undefined : j + 1);
  const cut = block.length > max ? [...block.slice(0, max), `    … (${block.length - max} more lines)`] : block;
  return cut.map((l) => `      ${l}`).join("\n");
}

function merge3(ours, base, theirs) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-land-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(dir, n));
    writeFileSync(o, ours);
    writeFileSync(b, base);
    writeFileSync(t, theirs);
    const r = spawnSync("git", ["merge-file", "-p", "-L", "main", "-L", "base", "-L", "worktree", o, b, t], {
      encoding: "buffer",
      maxBuffer: 64 << 20,
      windowsHide: true,
    });
    // 0 clean, 1..127 the number of conflicts, anything else an error.
    if (r.status === 0) return { ok: true, out: r.stdout };
    if (r.status > 0 && r.status < 128) return { ok: false, conflicts: r.status, out: r.stdout };
    return { ok: false, error: String(r.stderr || `merge-file exited ${r.status}`).trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The worker's changed paths against the base: committed in the worktree since the base, uncommitted, and new.
function changedPaths(wt, base) {
  const d = git(wt, ["diff", "--name-only", "--no-renames", "-z", base]);
  const u = git(wt, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!d.ok) throw new Error(`git diff in the worktree failed: ${d.err}`);
  return [...new Set([...d.out.split("\0"), ...u.out.split("\0")].filter(Boolean))].sort();
}

export function land(cwd, worktree, { files = [], dryRun = false, force = false, sessionId } = {}) {
  const say = [];
  const top = (dir) => git(dir, ["rev-parse", "--show-toplevel"]);
  const m = top(cwd);
  if (!m.ok) return { ok: false, text: `not in a git repository: ${cwd}` };
  const main = m.out.trim();
  if (!worktree || !existsSync(worktree)) return { ok: false, text: `no such worktree: ${worktree}` };
  const w = top(worktree);
  if (!w.ok) return { ok: false, text: `not a git worktree: ${worktree}` };
  const wt = w.out.trim();

  // Land from a worktree into the main tree of the same repository, never the other way or onto itself.
  const list = git(main, ["worktree", "list", "--porcelain"]);
  const primary = (list.out.split("\n").find((l) => l.startsWith("worktree ")) || "").slice(9);
  if (norm(primary) !== norm(main))
    return { ok: false, text: `run land from the main tree (${primary}), not from a worktree` };
  if (norm(wt) === norm(main)) return { ok: false, text: "the worktree is the main tree itself" };
  const common = (dir) => norm(resolve(dir, git(dir, ["rev-parse", "--git-common-dir"]).out.trim()));
  if (common(wt) !== common(main)) return { ok: false, text: `${wt} is not a worktree of ${main}` };

  const wtHead = git(wt, ["rev-parse", "HEAD"]).out.trim();
  const mb = git(main, ["merge-base", "HEAD", wtHead]);
  if (!mb.ok) return { ok: false, text: `no merge-base between main and the worktree's HEAD ${wtHead.slice(0, 7)}` };
  const base = mb.out.trim();

  const paths = files.length ? files.map((f) => f.replace(/\\/g, "/")) : changedPaths(wt, base).filter((p) => !SKIP.test(p));
  if (!paths.length) return { ok: true, text: `nothing to land: the worktree matches its base ${base.slice(0, 7)}` };
  say.push(`land from ${wt} (base ${base.slice(0, 7)}) into ${main}${dryRun ? " (dry run: nothing written)" : ""}`);

  const plan = []; // { path, how, write: Buffer | null }
  const refused = []; // { path, why, detail? }
  const notes = [];
  for (const p of paths) {
    const b = blob(main, base, p);
    const t = fileAt(wt, p);
    const o = fileAt(main, p);
    if (same(t, b)) {
      if (files.length) notes.push(`  - ${p}: unchanged in the worktree, skipped`);
      continue;
    }
    if (t === null) {
      refused.push({ path: p, why: "deleted in the worktree; delete it on main by hand if that is meant" });
      continue;
    }
    if (same(o, t)) {
      notes.push(`  - ${p}: main already has the worktree's version`);
      continue;
    }
    if (b === null) {
      if (o === null) plan.push({ path: p, how: "new", write: t });
      else refused.push({ path: p, why: "new in the worktree, but main has a different file at that path" });
      continue;
    }
    if (o === null) {
      refused.push({ path: p, why: "deleted on main since the worktree's base" });
      continue;
    }
    if (same(o, b)) {
      plan.push({ path: p, how: "taken (main unchanged since the base)", write: t });
      continue;
    }
    if (binary(o) || binary(b) || binary(t)) {
      refused.push({ path: p, why: "binary file changed on both sides" });
      continue;
    }
    const r = merge3(o, b, t);
    if (r.ok) plan.push({ path: p, how: "merged (both sides changed, no overlap)", write: r.out });
    else if (r.conflicts)
      refused.push({ path: p, why: `${r.conflicts} conflict(s) with main`, detail: firstConflict(String(r.out)) });
    else refused.push({ path: p, why: `merge failed: ${r.error}` });
  }

  // Cairn's own hold (hooks/pre_tool_use.mjs) never sees a write from here, so land checks it itself.
  for (const step of plan) {
    const holders = otherEditors(main, step.path, { exclude: sessionId, withinMs: HOLD_MS }).filter((s) => s.peer);
    if (holders.length && !force)
      refused.push({
        path: step.path,
        why: `held by ${holders.map((s) => `[${who(s)}] (edited it ${ago(s.editedAt)})`).join(", ")}; agree the split, then land again with --force`,
      });
    // A clean merge into a file with someone's uncommitted edits would commit them too: say so.
    const head = blob(main, "HEAD", step.path);
    if (!same(fileAt(main, step.path), head)) step.dirty = true;
  }

  for (const n of notes) say.push(n);
  if (refused.length) {
    say.push(`refused, nothing written (${refused.length} file(s)):`);
    for (const r of refused) say.push(`  - ${r.path}: ${r.why}${r.detail ? `\n${r.detail}` : ""}`);
    if (plan.length) say.push(`would have landed: ${plan.map((s) => s.path).join(", ")}`);
    say.push("Send the conflicts back to the worker to rebase on main, or settle them by hand on main.");
    return { ok: false, text: say.join("\n"), refused, plan };
  }
  if (!plan.length) return { ok: true, text: [...say, "nothing to write"].join("\n"), refused, plan };

  for (const s of plan) {
    say.push(`  - ${s.path}: ${s.how}${s.dirty ? "; main's copy had uncommitted edits, which are kept: agree with their owner before committing it" : ""}`);
    if (dryRun) continue;
    mkdirSync(dirname(join(main, s.path)), { recursive: true });
    writeFileSync(join(main, s.path), s.write);
    touch(main, sessionId, { file: s.path });
  }
  say.push(
    dryRun
      ? `dry run: ${plan.length} file(s) would land`
      : `landed ${plan.length} file(s). Check, then commit only these: git commit -m "<what and why>" -- ${plan.map((s) => s.path).join(" ")}`,
  );
  return { ok: true, text: say.join("\n"), refused, plan };
}
