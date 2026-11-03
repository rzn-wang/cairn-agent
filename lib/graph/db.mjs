// The knowledge graph's store: one SQLite file (node:sqlite, built into Node 22.13+; no npm dependency).
// It is derived and rebuildable: learnings.jsonl, checkpoints.jsonl and the code are the truth, the graph is an
// index over them. Hooks only ever open it read-only and treat any problem (missing, locked, corrupt, wrong schema,
// still building) as "no graph", which is exactly today's lexical behaviour.
//
// Location: the MAIN worktree's .claude/cairn/graph/, so every worktree of a repo shares one graph. A small
// pointer file, CURRENT, names the live database generation (g1.db, g2.db, …). A rebuild writes a new generation
// and flips the pointer, because Windows can't rename or delete a database another process holds open.
// CAIRN_GRAPH=0 turns the graph off; CAIRN_GRAPH_DB=<file> pins the database (tests); CAIRN_DIR moves it with
// the rest of the store.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION, createSchema } from "./schema.mjs";

export const enabled = () => process.env.CAIRN_GRAPH !== "0" && process.env.CAIRN_DISABLE !== "1";

let sqlite; // undefined: not tried; null: unavailable
// Synchronous (process.getBuiltinModule), so the hooks and recall builders stay synchronous.
export function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  // Node 22.5–23 print an ExperimentalWarning for node:sqlite. Hooks' stderr shows up in the session, so drop it.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    const msg = typeof w === "string" ? w : w?.message || "";
    if (/sqlite/i.test(msg)) return;
    return emit.call(process, w, ...rest);
  };
  try {
    const mod = process.getBuiltinModule?.("node:sqlite");
    if (!mod?.DatabaseSync) throw new Error("no node:sqlite");
    const probe = new mod.DatabaseSync(":memory:");
    probe.exec("CREATE VIRTUAL TABLE t USING fts5(x)"); // FTS5 is required for text search
    probe.close();
    sqlite = mod;
  } catch {
    sqlite = null;
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// The main worktree's root (the repo the graph indexes), even when called from a linked worktree.
const rootCache = new Map();
export function mainRoot(cwd = process.cwd()) {
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let root = cwd;
  try {
    const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    root = common.endsWith(".git") ? dirname(common) : git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    try {
      root = git(["rev-parse", "--show-toplevel"], cwd);
    } catch {
      /* not a git repo: index the folder */
    }
  }
  root = root.replace(/\\/g, "/");
  rootCache.set(cwd, root);
  return root;
}

export function graphPaths(cwd = process.cwd()) {
  let dir;
  if (process.env.CAIRN_GRAPH_DB) dir = dirname(process.env.CAIRN_GRAPH_DB);
  else if (process.env.CAIRN_DIR) dir = join(process.env.CAIRN_DIR, "graph");
  else dir = join(mainRoot(cwd), ".claude", "cairn", "graph");
  return { dir, pointer: join(dir, "CURRENT"), lock: join(dir, "lock"), stamp: join(dir, "stamp"), log: join(dir, "worker.log") };
}

export function currentDbFile(cwd = process.cwd()) {
  if (process.env.CAIRN_GRAPH_DB) return process.env.CAIRN_GRAPH_DB;
  const { dir, pointer } = graphPaths(cwd);
  try {
    const p = JSON.parse(readFileSync(pointer, "utf8"));
    if (p.db && p.schema === SCHEMA_VERSION) return join(dir, p.db);
  } catch {
    /* no graph yet */
  }
  return null;
}

// Point CURRENT at a generation: write a temp file and rename it over the pointer (atomic; nobody holds it open).
export function setCurrent(cwd, dbName) {
  const { dir, pointer } = graphPaths(cwd);
  mkdirSync(dir, { recursive: true });
  const tmp = `${pointer}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ db: dbName, schema: SCHEMA_VERSION, at: new Date().toISOString() }));
  renameSync(tmp, pointer);
}

export function nextGeneration(cwd) {
  if (process.env.CAIRN_GRAPH_DB) return { name: null, file: process.env.CAIRN_GRAPH_DB };
  const { dir, pointer } = graphPaths(cwd);
  let n = 0;
  try {
    n = Number(/g(\d+)\.db/.exec(JSON.parse(readFileSync(pointer, "utf8")).db)?.[1] || 0);
  } catch {
    /* first */
  }
  let name;
  do name = `g${++n}.db`;
  while (existsSync(join(dir, name)));
  return { name, file: join(dir, name) };
}

// --- reads (hooks) ---

const readers = new Map();
// A read-only handle, or null. Never throws; never waits more than 50 ms for a lock. Only usable handles are
// cached, so a graph that appears later in a long-lived process (the CLI, the selftest) is still found.
export function openRead(cwd = process.cwd(), { allowBuilding = false } = {}) {
  if (!enabled()) return null;
  const file = currentDbFile(cwd);
  if (!file || !existsSync(file)) return null;
  const ck = `${file}|${allowBuilding}`;
  if (readers.has(ck)) return readers.get(ck);
  const mod = loadSqlite();
  if (!mod) return null;
  let db = null;
  try {
    db = new mod.DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout=50; PRAGMA query_only=1; PRAGMA cache_size=-16000");
    const state = meta(db, "build_state");
    if (Number(meta(db, "schema_version")) !== SCHEMA_VERSION || !(state === "ready" || state === "updating" || (allowBuilding && state))) {
      db.close();
      db = null;
    }
  } catch {
    try {
      db?.close();
    } catch {
      /* already unusable */
    }
    db = null;
  }
  if (db) readers.set(ck, db);
  return db;
}

export function closeReaders() {
  for (const db of readers.values())
    try {
      db.close();
    } catch {
      /* closed */
    }
  readers.clear();
}

// --- writes (the worker only) ---

export function openWrite(file) {
  const mod = loadSqlite();
  if (!mod) throw new Error("node:sqlite with FTS5 is not available (the graph needs Node 22.13 or newer)");
  mkdirSync(dirname(file), { recursive: true });
  const fresh = !existsSync(file);
  const db = new mod.DatabaseSync(file);
  if (fresh) db.exec("PRAGMA page_size=8192");
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY; PRAGMA wal_autocheckpoint=2000; PRAGMA cache_size=-65536");
  if (fresh) createSchema(db);
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction is already gone */
    }
    throw err;
  }
}

export function meta(db, k) {
  try {
    return db.prepare("SELECT v FROM meta WHERE k=?").get(k)?.v ?? null;
  } catch {
    return null;
  }
}
export function setMeta(db, k, v) {
  db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, typeof v === "string" ? v : JSON.stringify(v));
}
export function metaJson(db, k) {
  try {
    return JSON.parse(meta(db, k));
  } catch {
    return null;
  }
}

// Old generations: deleted once nothing holds them (Windows refuses while a reader has one open).
export function gcGenerations(cwd) {
  const { dir } = graphPaths(cwd);
  const cur = (currentDbFile(cwd) || "").split(/[\\/]/).pop();
  let removed = 0;
  try {
    for (const f of readdirSync(dir)) {
      const m = /^(g\d+\.db)(-wal|-shm)?$/.exec(f);
      if (!m || m[1] === cur) continue;
      try {
        if (Date.now() - statSync(join(dir, f)).mtimeMs < 10 * 60000) continue; // may still be building
        rmSync(join(dir, f), { force: true });
        removed++;
      } catch {
        /* EBUSY: next time */
      }
    }
  } catch {
    /* no graph dir */
  }
  return removed;
}
