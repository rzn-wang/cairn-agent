// Files that change together, from git history. Works for every language with no parser, which is why it is the
// graph's first structural signal.
//
// Each commit c with n kept files adds r·s to every pair, where r = 0.5^(age / halfLife) favours recent history
// (age measured from the newest commit) and s = 1 / log2(1 + n) discounts big commits (a 2-file commit counts 0.63, a 30-file one 0.20). The weight of a
// pair is the cosine (Ochiai) of those sums: w(a,b) = C[a,b] / sqrt(C[a]·C[b]), so 1.0 means "always together".
// Skipped: merges, commits over maxFilesPerCommit files, mass formatting / dependency bumps, and files that are
// generated, vendored or gone. Renames are followed, so a file keeps the history of its old name.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { globRegex } from "../config.mjs";
import { EDGE, KIND } from "./schema.mjs";

// Stream `git log`, calling onCommit({ sha, t, subject, files: [currentPath…] }) newest first.
export function readHistory(root, { commits, days, rev = "HEAD", onCommit }) {
  return new Promise((resolve) => {
    const args = [
      "-c", "core.quotePath=false",
      "log", "--no-merges", "-M", "--name-status",
      `--format=%x01%H%x02%ct%x02%s`,
      `-n${commits}`,
    ];
    if (days) args.push(`--since=${days}.days.ago`);
    args.push(rev || "HEAD", "--");
    let child;
    try {
      child = spawn("git", args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(0);
      return;
    }
    const alias = new Map(); // an older name -> the file's current name
    let cur = null;
    let n = 0;
    const flush = () => {
      if (cur) {
        n++;
        onCommit(cur);
      }
      cur = null;
    };
    const unq = (p) => (p.startsWith('"') ? p.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t") : p);
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.startsWith("\x01")) {
        flush();
        const [sha, t, subject] = line.slice(1).split("\x02");
        cur = { sha, t: Number(t), subject: subject || "", files: [] };
        return;
      }
      if (!cur || !line) return;
      const parts = line.split("\t");
      const status = parts[0];
      if (status[0] === "R" || status[0] === "C") {
        const from = unq(parts[1]);
        const to = unq(parts[2]);
        const now = alias.get(to) || to;
        if (status[0] === "R") alias.set(from, now);
        cur.files.push(now);
      } else if (parts[1]) {
        const p = unq(parts[1]);
        cur.files.push(alias.get(p) || p);
      }
    });
    rl.on("close", () => {
      flush();
      resolve(n);
    });
    child.on("error", () => resolve(n));
  });
}

// Build co_changed edges, file churn and recent commit nodes. `files`: Map path -> node id of the files that
// count (src, test, doc, config; not deleted). Replaces what an earlier run stored.
export async function buildCochange(db, w, root, files, cfg, { onProgress } = {}) {
  const c = cfg.cochange;
  const ignore = (() => {
    try {
      return new RegExp(c.ignoreMessages, "i");
    } catch {
      return null;
    }
  })();
  const skip = (c.ignore || []).map((g) => globRegex(g));
  const idx = new Map(); // path -> dense index
  const paths = [];
  for (const p of files.keys()) {
    if (skip.some((re) => re.test(p))) continue;
    idx.set(p, paths.length);
    paths.push(p);
  }
  const N = paths.length;
  const single = new Float64Array(N);
  const touches = new Float64Array(N); // decayed touch count, for churn
  const raw = new Uint32Array(N); // commits touching each file, for the hub rule
  // Pair sums in growable typed arrays keyed by a*2^22+b (N stays below 4M files).
  const slot = new Map();
  let cap = 1 << 16;
  let pairW = new Float64Array(cap);
  let pairN = new Uint32Array(cap);
  let used = 0;
  let newest = 0; // ages count from the newest commit, so a quiet repo's history isn't all "old"
  const recent = [];
  let seen = 0;
  let skipped = 0;

  await readHistory(root, {
    commits: c.commits,
    days: c.days,
    rev: c.rev, // the benchmark builds co-change from older history to test on newer commits
    onCommit(commit) {
      seen++;
      if (onProgress && seen % 2000 === 0) onProgress(seen);
      const ids = [...new Set(commit.files.map((p) => idx.get(p)).filter((i) => i !== undefined))];
      if (recent.length < c.commitNodes) recent.push({ ...commit, ids });
      const n = ids.length;
      if (!n) return;
      if (n > c.maxFilesPerCommit || (ignore && n > 10 && ignore.test(commit.subject))) {
        skipped++;
        return;
      }
      if (!newest) newest = commit.t;
      const ageDays = Math.max(0, (newest - commit.t) / 86400);
      const r = Math.pow(0.5, ageDays / c.halfLifeDays);
      const s = 1 / Math.log2(1 + n);
      for (const i of ids) {
        single[i] += r * s;
        touches[i] += r;
        raw[i]++;
      }
      if (n < 2) return;
      ids.sort((x, y) => x - y);
      for (let x = 0; x < n; x++)
        for (let y = x + 1; y < n; y++) {
          const key = ids[x] * 4194304 + ids[y];
          let k = slot.get(key);
          if (k === undefined) {
            if (used === cap) {
              cap *= 2;
              const w2 = new Float64Array(cap);
              w2.set(pairW);
              pairW = w2;
              const n2 = new Uint32Array(cap);
              n2.set(pairN);
              pairN = n2;
            }
            k = used++;
            slot.set(key, k);
          }
          pairW[k] += r * s;
          pairN[k] += 1;
        }
    },
  });

  // Keep each file's topK strongest partners above the floor.
  const best = new Map(); // index -> [[partner, w]]
  const offer = (a, b, wt) => {
    let list = best.get(a);
    if (!list) best.set(a, (list = []));
    list.push([b, wt]);
  };
  const kept = seen - skipped;
  const hub = (i) => kept >= 200 && raw[i] > kept * (c.hubShare ?? 1);
  for (const [key, k] of slot) {
    if (pairN[k] < c.minSupport) continue;
    const a = Math.floor(key / 4194304);
    const b = key - a * 4194304;
    if (hub(a) || hub(b)) continue;
    const wt = pairW[k] / Math.sqrt(single[a] * single[b]);
    if (wt < c.minWeight) continue;
    offer(a, b, wt);
    offer(b, a, wt);
  }

  const insCommit = db.prepare(
    "INSERT INTO node(kind,key,name,t) VALUES(?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET name=excluded.name, t=excluded.t RETURNING id",
  );
  const setChurn = db.prepare("UPDATE node SET churn=? WHERE id=?");
  let edges = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM edge WHERE type=?").run(EDGE.co_changed);
    for (const [a, list] of best) {
      list.sort((x, y) => y[1] - x[1]);
      for (const [b, wt] of list.slice(0, c.topK)) {
        w.st.edge.run(files.get(paths[a]), EDGE.co_changed, files.get(paths[b]), Math.round(wt * 1000) / 1000, null);
        edges++;
      }
    }
    db.prepare("UPDATE node SET churn=NULL WHERE kind=? AND churn IS NOT NULL").run(KIND.file);
    for (let i = 0; i < N; i++) if (touches[i] > 0) setChurn.run(1 - Math.exp(-touches[i] / 5), files.get(paths[i]));
    // Commit nodes: the newest ones, plus whatever learnings cite (memory.mjs links those by sha prefix).
    const keep = new Set();
    for (const cm of recent) {
      const id = insCommit.get(KIND.commit, cm.sha, cm.subject.slice(0, 200), cm.t).id;
      keep.add(id);
      w.st.delEdgesFrom.run(id);
      w.st.ftsMemDel.run(id);
      w.st.ftsMem.run(cm.subject, id, KIND.commit);
      if (cm.ids.length <= c.maxFilesPerCommit) for (const i of cm.ids) w.st.edge.run(id, EDGE.in_commit, files.get(paths[i]), 1, null);
    }
    const cited = new Set(db.prepare("SELECT dst FROM edge WHERE type=?").all(EDGE.source).map((r) => r.dst));
    for (const r of db.prepare("SELECT id FROM node WHERE kind=?").all(KIND.commit)) if (!keep.has(r.id) && !cited.has(r.id)) w.remove(r.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { commits: seen, skipped, pairs: slot.size, edges, files: N };
}
