// `cairn graph bench [--repo <path>] [--queries n]`: how the graph performs on a real repo, in a throwaway store.
//   build      full build time per phase, peak memory, database size
//   update     one changed file, then a memory-only sync
//   recall     graphRecall latency over n queries made from recent commits (first file + subject)
//   quality    held-out: co-change built from history older than the last n commits; for each newer commit,
//              seed one of its files and count how many of its other files land in the top 20 (recall@20),
//              for imports only, co-change only, and both

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;

export async function bench(cwd, { repo, queries = 200 } = {}) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo || cwd, encoding: "utf8" }).trim();
  const store = mkdtempSync(join(tmpdir(), "cairn-bench-"));
  process.env.CAIRN_DIR = store;
  process.env.CAIRN_GRAPH_AUTO = "0";
  const db = await import("./db.mjs");
  const { runWorker } = await import("./worker.mjs");
  const { graphRecall } = await import("./recall.mjs");
  const out = (s) => console.log(s);
  out(`bench: ${root}`);
  out(`  ${execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 30 }).split("\n").length - 1} tracked files, ${execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim()} commits`);
  try {
    // 1. full build
    const t0 = Date.now();
    const s = await runWorker(root, { mode: "full", fg: true, quiet: true });
    const total = Date.now() - t0;
    if (s.error) return out(`  build failed: ${s.error}`);
    const file = db.currentDbFile(root);
    out(`  full build: ${(total / 1000).toFixed(1)} s  (inventory ${s.t_inventory} ms, extract ${s.t_extract} ms, resolve ${s.t_resolve} ms, co-change ${s.t_cochange ?? "-"} ms, areas ${s.t_communities ?? "-"} ms)`);
    out(`  peak RSS ${mb(process.resourceUsage().maxRSS * 1024)}; database ${mb(statSync(file).size)} (${Math.round(statSync(file).size / Math.max(1, s.files))} bytes/file)`);
    out(`  ${s.files} files, ${s.extracted} read, imports ${s.resolved?.edges} edges; co-change ${s.cochange?.commits} commits → ${s.cochange?.edges} edges`);

    // 2. incremental: forget one file's stored hash (the working tree is never touched), then update
    const h = db.openRead(root);
    const victim = h.prepare("SELECT key FROM node WHERE kind=1 AND role=0 AND lang IS NOT NULL AND (flags & 1)=0 ORDER BY churn DESC NULLS LAST LIMIT 1").get()?.key;
    db.closeReaders();
    if (victim) {
      const wdb = db.openWrite(file);
      wdb.prepare("UPDATE node SET hash=NULL WHERE kind=1 AND key=?").run(victim);
      wdb.close();
      const t1 = Date.now();
      const u = await runWorker(root, { mode: "update", quiet: true });
      out(`  update with ${victim} changed: ${Date.now() - t1} ms (${u.extracted} file read)`);
    }
    const t2 = Date.now();
    await runWorker(root, { mode: "memory", quiet: true });
    out(`  memory-only sync: ${Date.now() - t2} ms`);

    // 3. recall latency
    const log = execFileSync("git", ["log", "--no-merges", "--name-only", "--format=%x01%s", `-n${queries}`], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
    const commits = log
      .split("\x01")
      .filter(Boolean)
      .map((b) => {
        const [subject, ...files] = b.split("\n").filter(Boolean);
        return { subject, files };
      })
      .filter((c) => c.files.length);
    db.closeReaders();
    const times = [];
    const first = performance.now();
    graphRecall(root, { text: "warm up", terms: [], files: [] });
    const coldOpen = performance.now() - first;
    for (const c of commits) {
      const terms = c.subject.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 3);
      const t = performance.now();
      graphRecall(root, { text: c.subject, terms, files: [c.files[0]], editedFiles: [c.files[0]] });
      times.push(performance.now() - t);
    }
    out(`  recall over ${times.length} queries: p50 ${pct(times, 50).toFixed(1)} ms, p95 ${pct(times, 95).toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms (first open ${coldOpen.toFixed(1)} ms)`);

    // 4. held-out quality: co-change from history before the sampled commits
    const holdout = Math.min(500, Math.floor(commits.length));
    const cutoff = execFileSync("git", ["rev-list", "--no-merges", `--skip=${holdout}`, "-n1", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (cutoff) {
      const { openWrite } = db;
      const { buildCochange } = await import("./cochange.mjs");
      const { graphConfig } = await import("./gconfig.mjs");
      const { writer } = await import("./write.mjs");
      const { activate } = await import("./query.mjs");
      db.closeReaders();
      const w0 = openWrite(file);
      const cfg = graphConfig(root);
      const live = new Map(w0.prepare("SELECT key, id FROM node WHERE kind=1 AND (flags & 1)=0 AND role IN (0,1,2,3)").all().map((r) => [r.key, r.id]));
      await buildCochange(w0, writer(w0), root, live, { ...cfg, cochange: { ...cfg.cochange, rev: cutoff } });
      w0.close();
      const h2 = db.openRead(root);
      const idOf = h2.prepare("SELECT id FROM node WHERE kind=1 AND key=?");
      const keyOf = h2.prepare("SELECT key, kind FROM node WHERE id=?");
      const variants = {
        imports: { co_changed: { out: 0 } },
        cochange: { imports: { out: 0, in: 0 }, references: { out: 0, in: 0 }, tests: { out: 0, in: 0 } },
        both: {},
      };
      const res = {};
      let n = 0;
      for (const c of commits.slice(0, holdout)) {
        const ids = c.files.map((f) => idOf.get(f)?.id).filter(Boolean);
        if (ids.length < 2 || ids.length > 30) continue;
        n++;
        const rest = new Set(c.files.slice(1));
        for (const [name, weights] of Object.entries(variants)) {
          const act = activate(h2, new Map([[ids[0], 1]]), { ...cfg.query, weights, budgetMs: 200 });
          const top = [...act.A]
            .filter(([id]) => id !== ids[0])
            .map(([id, a]) => [keyOf.get(id), a])
            .filter(([k]) => k?.kind === 1)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([k]) => k.key);
          const hit = top.filter((k) => rest.has(k)).length;
          res[name] = (res[name] || 0) + hit / rest.size;
        }
      }
      if (n) out(`  held-out recall@20 over ${n} commits: ${Object.entries(res).map(([k, v]) => `${k} ${((v / n) * 100).toFixed(1)}%`).join(", ")}`);
    }
  } finally {
    db.closeReaders();
    rmSync(store, { recursive: true, force: true });
  }
}
