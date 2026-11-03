// Graph lines for `cairn status` and checks for `cairn doctor`.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { currentDbFile, enabled, graphPaths, loadSqlite, mainRoot, meta, metaJson, openRead } from "./db.mjs";
import { graphConfig } from "./gconfig.mjs";
import { lockFresh, readLock } from "./lock.mjs";
import { cli } from "../cmd.mjs";

function headLag(root, indexed) {
  if (!indexed) return null;
  try {
    return Number(execFileSync("git", ["rev-list", "--count", `${indexed}..HEAD`], { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return null;
  }
}

export function graphLine(cwd) {
  if (!enabled()) return "graph: off (CAIRN_GRAPH=0)";
  if (!loadSqlite()) return "graph: unavailable (needs Node 22.13+)";
  const db = openRead(cwd, { allowBuilding: true });
  if (!db) return "graph: not built (`cairn graph build`)";
  const st = metaJson(db, "stats") || {};
  const n = st.nodes || {};
  return `graph: ${meta(db, "build_state")}, ${n[1] || 0} files, ${n[4] || 0} symbols, ${Object.values(st.edges || {}).reduce((a, b) => a + b, 0)} edges (\`cairn graph status\`)`;
}

export function graphChecks(cwd) {
  const out = [];
  if (!enabled()) return [["graph", true, "off (CAIRN_GRAPH=0)"]];
  const cfg = graphConfig(cwd);
  if (!cfg.enabled) return [["graph", true, "off in config (project.graph.enabled)"]];
  const sql = loadSqlite();
  out.push(["graph: node:sqlite with FTS5", !!sql, sql ? `Node ${process.versions.node}` : `Node ${process.versions.node}; the graph needs 22.13+, recall stays text-only`]);
  if (!sql) return out;
  const file = currentDbFile(cwd);
  if (!file || !existsSync(file)) {
    out.push(["graph: built", false, `run \`${cli()} graph build\` (sessions start one automatically)`]);
    return out;
  }
  const db = openRead(cwd, { allowBuilding: true });
  out.push(["graph: opens", !!db, db ? file : "locked, corrupt or an old schema; `graph build --full` rebuilds it"]);
  if (!db) return out;
  const state = meta(db, "build_state");
  out.push(["graph: state", state === "ready" || state === "updating", state]);
  let ok = false;
  try {
    ok = db.prepare("PRAGMA quick_check(1)").get()?.quick_check === "ok";
  } catch {
    ok = false;
  }
  out.push(["graph: integrity", ok, ok ? "" : "rebuild with `graph build --full`"]);
  const root = mainRoot(cwd);
  const lag = headLag(root, meta(db, "indexed_head"));
  out.push(["graph: up to date", lag === null || lag <= 20, lag === null ? "unknown" : `${lag} commit(s) behind HEAD`]);
  const lock = readLock(cwd);
  out.push(["graph: worker lock", !lock || lockFresh(lock), !lock ? "idle" : lockFresh(lock) ? `running (pid ${lock.pid})` : "stale (the next update takes it over)"]);
  try {
    const wal = statSync(file + "-wal").size;
    out.push(["graph: WAL size", wal < 64 * 1048576, `${(wal / 1048576).toFixed(1)} MB`]);
  } catch {
    /* no WAL: fine */
  }
  const st = metaJson(db, "stats") || {};
  if (st.imports > 50) {
    const pct = Math.round(((st.unresolved || 0) / st.imports) * 100);
    out.push(["graph: imports resolved", pct <= 30, `${100 - pct}% (unresolved ones are mostly external packages; set project.graph.pathAliases / pythonRoots if your own aren't found)`]);
  }
  try {
    const rel = graphPaths(cwd).dir.replace(root + "/", "");
    execFileSync("git", ["check-ignore", "-q", `${rel}/x.db`], { cwd: root, stdio: "ignore" });
    out.push(["graph: git-ignored", true]);
  } catch {
    out.push(["graph: git-ignored", !!process.env.CAIRN_DIR, "add .claude/cairn/graph/ to .gitignore (`cairn init --yes` scopes .claude/cairn/)"]);
  }
  return out;
}
