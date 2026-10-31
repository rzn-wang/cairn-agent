// `cairn decide "<row>"`: log one of Robin's decisions in docs/DECISIONS.md and commit that row alone. Every session
// appends to that file, so a pathspec commit carried other sessions' uncommitted rows three times on 2026-10-15 to
// 10-21. This builds the commit from HEAD's copy plus the one row, in a private index, so neither other sessions'
// rows in the working file nor anything in the shared staging area can ride along. The row is also appended to the
// working file, after whatever others have there.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd, args, { input, env, raw = false } = {}) {
  const r = spawnSync("git", args, { cwd, input, encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
  return { ok: r.status === 0, out: raw ? r.stdout || "" : (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

export function decide(cwd, row, { file = "docs/DECISIONS.md", message } = {}) {
  const line = String(row || "").trim();
  if (!/^\|.*\|$/.test(line) || line.includes("\n")) return { ok: false, text: "a decision is one table row: | … | … |" };
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).out;
  if (!root) return { ok: false, text: "not in a git repository" };
  const path = join(root, file);
  if (!existsSync(path)) return { ok: false, text: `no ${file}` };

  for (let attempt = 0; attempt < 3; attempt++) {
    const head = git(root, ["rev-parse", "HEAD"]).out;
    const base = git(root, ["show", `${head}:${file}`], { raw: true });
    if (!base.ok) return { ok: false, text: `${file} is not in HEAD` };
    const committed = base.out.endsWith("\n") ? `${base.out}${line}\n` : `${base.out}\n${line}\n`;
    const blob = git(root, ["hash-object", "-w", "--stdin"], { input: committed }).out;
    const tmp = mkdtempSync(join(tmpdir(), "cairn-decide-"));
    try {
      const env = { GIT_INDEX_FILE: join(tmp, "index") };
      git(root, ["read-tree", head], { env });
      git(root, ["update-index", "--cacheinfo", `100644,${blob},${file}`], { env });
      const tree = git(root, ["write-tree"], { env }).out;
      const msg = message || `Log Robin: ${line.replace(/\*\*/g, "").slice(2, 90).trim()}`;
      const commit = git(root, ["commit-tree", tree, "-p", head], { input: `${msg}\n` });
      if (!commit.ok) return { ok: false, text: `commit failed: ${commit.err}` };
      // Move HEAD only if nobody committed meanwhile; otherwise build again on the new HEAD.
      const moved = git(root, ["update-ref", "-m", "cairn decide", "HEAD", commit.out, head]);
      if (!moved.ok) continue;
      // The shared index still holds the old blob for this file unless someone staged it: bring it level.
      const staged = git(root, ["ls-files", "-s", "--", file]).out.split(/\s+/)[1];
      const oldBlob = git(root, ["rev-parse", `${head}:${file}`]).out;
      if (staged === oldBlob) git(root, ["update-index", "--cacheinfo", `100644,${blob},${file}`]);
      // The working file keeps everyone's uncommitted rows; ours goes after them.
      const work = readFileSync(path, "utf8");
      writeFileSync(path, work.endsWith("\n") || !work ? `${work}${line}\n` : `${work}\n${line}\n`);
      return { ok: true, commit: commit.out.slice(0, 7), text: `committed ${commit.out.slice(0, 7)}: ${msg}` };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { ok: false, text: "HEAD kept moving; try again" };
}
