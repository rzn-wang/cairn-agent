// The graph worker: the only process that writes the graph. Runs detached (spawned by hooks through
// lock.maybeSpawn, by `cairn mine` after each commit, or by `cairn graph build`), holds the lock, and works in
// short transactions so readers are never blocked for long. Work it can't finish in its time budget is picked up
// by the next run: a file's stored hash only changes once it has been extracted.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildCommunities } from "./communities.mjs";
import { buildCochange } from "./cochange.mjs";
import { currentDbFile, gcGenerations, graphPaths, mainRoot, meta, metaJson, nextGeneration, openWrite, setCurrent, setMeta } from "./db.mjs";
import { cochangeHash, configHash, graphConfig } from "./gconfig.mjs";
import { extractFiles, inventory, markDeleted, recomputeDegrees, resolveFiles } from "./indexer.mjs";
import { acquire } from "./lock.mjs";
import { syncMemory } from "./memory.mjs";
import { FLAG, KIND, SCHEMA_VERSION } from "./schema.mjs";
import { writer } from "./write.mjs";

function headSha(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function quickCheck(db) {
  try {
    return db.prepare("PRAGMA quick_check(1)").get()?.quick_check === "ok";
  } catch {
    return false;
  }
}

// mode: "auto" (whatever is due), "update" (same), "memory" (memory only), "full" (new generation from scratch).
export async function runWorker(cwd, { mode = "auto", budgetMs, quiet = false, fg = false } = {}) {
  const root = mainRoot(cwd);
  const cfg = graphConfig(root);
  if (!cfg.enabled) return { skipped: "graph disabled in config" };
  const paths = graphPaths(cwd);
  mkdirSync(paths.dir, { recursive: true });
  const say = (msg) => {
    const line = `${new Date().toISOString().slice(0, 19)} ${msg}`;
    try {
      appendFileSync(paths.log, line + "\n");
    } catch {
      /* the log is a courtesy */
    }
    if (!quiet) process.stderr.write(`[graph] ${msg}\n`);
  };
  const release = acquire(cwd, mode);
  if (!release) return { skipped: "another graph update is running" };
  const started = Date.now();
  const budget = budgetMs ?? (fg || mode === "full" ? Infinity : cfg.updateBudgetMs);
  const deadline = started + budget;
  let db;
  const stats = { mode };
  try {
    // Which database: the current one, or a new generation (first build, --full, schema change, corruption).
    let file = currentDbFile(cwd);
    let fresh = false;
    if (file && existsSync(file) && mode !== "full") {
      db = openWrite(file);
      // The integrity check reads the whole file (seconds at 500 MB), so it runs only after a run that failed.
      const suspect = meta(db, "last_run") === "failed";
      if (Number(meta(db, "schema_version")) !== SCHEMA_VERSION || (suspect && !quickCheck(db))) {
        db.close();
        db = null;
      }
    }
    if (!db) {
      const gen = nextGeneration(cwd);
      file = gen.file;
      if (process.env.CAIRN_GRAPH_DB && existsSync(file)) for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true });
      db = openWrite(file);
      fresh = true;
      say(`building a new graph: ${file}`);
      // The very first graph is pointed at right away (readers skip it while it says "building", but the seed can
      // say a build is under way). A rebuild is pointed at only once it's done, so recall keeps the old one.
      if (!currentDbFile(cwd) && gen.name) setCurrent(cwd, gen.name);
    }
    setMeta(db, "last_run", "failed"); // until this run finishes
    const state0 = meta(db, "build_state");
    if (!fresh && state0 === "ready") setMeta(db, "build_state", "updating");
    const w = writer(db);
    const progress = (phase, done, total) => setMeta(db, "progress", { phase, done, total, at: Date.now() });

    // Config changes that alter extraction: re-extract everything (hashes cleared).
    const ch = configHash(cfg);
    if (meta(db, "config_hash") !== ch) {
      if (!fresh) db.prepare("UPDATE node SET hash=NULL WHERE kind=?").run(KIND.file);
      setMeta(db, "config_hash", ch);
    }

    if (mode !== "memory") {
      // 1. inventory
      let tp = Date.now();
      const lap = (name) => {
        stats[`t_${name}`] = Date.now() - tp;
        tp = Date.now();
      };
      progress("inventory", 0, 0);
      const inv = inventory(db, w, root, cfg, { onProgress: (d, t) => progress("inventory", d, t) });
      stats.files = inv.total;
      stats.added = inv.added;
      stats.changed = inv.toExtract.length;
      stats.deleted = inv.deleted.length;
      stats.roles = inv.roles;
      say(`inventory: ${inv.total} files, ${inv.added} new, ${inv.toExtract.length} to read, ${inv.deleted.length} gone`);
      const reresolve = markDeleted(db, w, inv.deleted);
      lap("inventory");

      // 2. memory, early: recall gets the learning mirror even while a first build is still extracting
      // Memory comes from the main worktree's store: the graph is shared by every worktree, and syncing a worktree's
      // own store would make the memory nodes flip between stores (CAIRN_DIR still overrides).
      stats.memory = syncMemory(db, w, root, root, { force: fresh });
      lap("memory");

      // 3. extract
      progress("extract", 0, inv.toExtract.length);
      const ex = await extractFiles(db, w, root, inv.toExtract, cfg, {
        deadline,
        onProgress: (d, t) => {
          progress("extract", d, t);
          if (!quiet && fg && d % 5000 < 500) say(`extract: ${d}/${t}`);
        },
      });
      stats.extracted = ex.done.length;
      stats.pending = ex.rest;
      for (const id of ex.done) reresolve.add(id);
      lap("extract");
      // Memory synced before extraction couldn't link to symbols that didn't exist yet: redo it after big changes.
      if ((fresh || ex.done.length > 500) && ex.done.length) syncMemory(db, w, root, root, { force: true });

      // 4. resolve
      progress("resolve", 0, reresolve.size);
      const rs = await resolveFiles(db, w, root, reresolve, cfg, { includeUnresolved: inv.added > 0 || inv.deleted.length > 0 || fresh });
      stats.resolved = rs;
      lap("resolve");

      // 5. co-change: on a fresh build, a settings change, or when due
      const head = headSha(root);
      const cch = cochangeHash(cfg);
      const lastAt = Number(meta(db, "cochange_built_at") || 0);
      const due =
        fresh || meta(db, "cochange_hash") !== cch || (meta(db, "cochange_head") !== head && Date.now() - lastAt > cfg.cochange.minIntervalMin * 60000);
      if (due && Date.now() < deadline + (fg ? Infinity : 0)) {
        progress("cochange", 0, 0);
        const live = new Map(
          db
            .prepare("SELECT key, id FROM node WHERE kind=? AND (flags & ?) = 0 AND role IN (0,1,2,3)")
            .all(KIND.file, FLAG.deleted)
            .map((r) => [r.key, r.id]),
        );
        const cc = await buildCochange(db, w, root, live, cfg, { onProgress: (n) => progress("cochange", n, cfg.cochange.commits) });
        setMeta(db, "cochange_head", head || "");
        setMeta(db, "cochange_hash", cch);
        setMeta(db, "cochange_built_at", String(Date.now()));
        stats.cochange = cc;
        lap("cochange");
        say(`co-change: ${cc.commits} commits (${cc.skipped} skipped), ${cc.edges} edges`);
      }

      // 6. inferred areas when there's no AREAS.md, after co-change (they use both kinds of edge)
      const areasDue = (due || ex.done.length > 500 || fresh) && !existsSync(join(root, "docs", "AREAS.md"));
      if (areasDue && Date.now() < deadline + (fg ? Infinity : 0)) {
        progress("communities", 0, 0);
        stats.areas = buildCommunities(db, w);
        lap("communities");
      }

      // In-degree is for stats and the CLI; recount it after big changes only (it walks every edge).
      if (fresh || ex.done.length > 500 || inv.deleted.length > 100) recomputeDegrees(db);
      setMeta(db, "indexed_head", head || "");
    } else {
      stats.memory = syncMemory(db, w, root, root);
    }

    const ms = Date.now() - started;
    const prev = metaJson(db, "stats") || {};
    setMeta(db, "stats", { ...prev, ...summary(db), [`last_${mode === "full" || fresh ? "build" : "update"}_ms`]: ms, at: Date.now() });
    setMeta(db, "progress", { phase: "done", at: Date.now() });
    setMeta(db, "last_run", "ok");
    // A first build counts as ready once nothing is left to extract; until then hooks ignore it.
    if (!stats.pending) setMeta(db, "build_state", "ready");
    else if (!fresh || state0 === "ready") setMeta(db, "build_state", "updating");
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* readers hold it; next run */
    }
    db.close();
    db = null;
    if (fresh && !process.env.CAIRN_GRAPH_DB) setCurrent(cwd, file.split(/[\\/]/).pop());
    gcGenerations(cwd);
    stats.ms = ms;
    say(`done in ${(ms / 1000).toFixed(1)} s${stats.pending ? `, ${stats.pending} files left for the next run` : ""}`);
    return stats;
  } catch (err) {
    say(`failed: ${err?.stack || err}`);
    stats.error = String(err?.message || err);
    return stats;
  } finally {
    try {
      db?.close();
    } catch {
      /* closed */
    }
    release();
  }
}

export function summary(db) {
  const byKind = Object.fromEntries(db.prepare("SELECT kind, count(*) AS n FROM node GROUP BY kind").all().map((r) => [r.kind, r.n]));
  const byEdge = Object.fromEntries(db.prepare("SELECT type, count(*) AS n FROM edge GROUP BY type").all().map((r) => [r.type, r.n]));
  const spec = db.prepare("SELECT count(*) AS n, sum(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS u FROM spec WHERE kind NOT IN ('package','mention-path','mention-ident')").get();
  return { nodes: byKind, edges: byEdge, imports: spec.n || 0, unresolved: spec.u || 0 };
}

