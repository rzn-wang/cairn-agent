// `cairn graph <sub>`: build, inspect and query the knowledge graph (docs/CAIRN.md "Knowledge graph").

import { existsSync, statSync } from "node:fs";
import { currentDbFile, graphPaths, loadSqlite, meta, metaJson, openRead } from "./db.mjs";
import { graphConfig } from "./gconfig.mjs";
import { lockFresh, readLock, spawnWorker } from "./lock.mjs";
import { activate, codeIdents, resolveSeeds, why } from "./query.mjs";
import { EDGE, EDGE_NAME, FLAG, KIND, KIND_NAME, ROLE_NAME } from "./schema.mjs";
import { cli } from "../cmd.mjs";

const USAGE = `usage: cairn.mjs graph <command>
  build [--fg] [--full]        build or update the graph (detached unless --fg; --full starts a new one)
  update [--mode auto|memory]  what hooks run in the background
  status                       state, counts, freshness, lock
  neighbors <path|symbol> [--type t] [--limit n]
  impact <path>                what depends on a file: importers, tests, docs, co-changing files, memory
  query "<text>" [--files a,b] the recall pipeline with its score breakdown
  explain <learning-key>       what a learning cites and which files would recall it
  path <a> <b>                 the strongest link between two files or symbols
  areas                        inferred areas, as a table to paste into docs/AREAS.md
  export --dot|--json [--root p] [--depth 2] [--types imports,co_changed] [--limit 2000]
  bench [--repo <path>] [--queries n]`;

function need(cwd) {
  const db = openRead(cwd, { allowBuilding: true });
  if (!db) {
    console.log(loadSqlite() ? `No graph yet. Run: ${cli()} graph build` : "The graph needs Node 22.13+ (node:sqlite with FTS5).");
    process.exit(1);
  }
  return db;
}

function findNode(db, cwd, arg) {
  const p = String(arg).replace(/\\/g, "/").replace(/^\.\//, "");
  let r = db.prepare("SELECT * FROM node WHERE kind=1 AND key=?").get(p);
  if (r) return r;
  const base = p.split("/").pop().toLowerCase();
  const hits = db.prepare("SELECT * FROM node WHERE kind=1 AND lname=?").all(base).filter((n) => n.key.endsWith("/" + p) || n.key === p);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    console.log(`"${arg}" matches ${hits.length} files:\n${hits.slice(0, 10).map((h) => "  " + h.key).join("\n")}`);
    process.exit(1);
  }
  const [file, sym] = p.split("#");
  if (sym) {
    const f = findNode(db, cwd, file);
    r = db.prepare("SELECT * FROM node WHERE kind=4 AND file_id=? AND name=?").get(f.id, sym);
    if (r) return r;
  }
  const syms = db.prepare("SELECT * FROM node WHERE kind=4 AND (name=? OR lname=?) LIMIT 10").all(p, p.toLowerCase());
  if (syms.length === 1) return syms[0];
  if (syms.length > 1) {
    console.log(`"${arg}" names ${syms.length} symbols; use <path>#<name>:`);
    for (const s of syms) console.log(`  ${fileOf(db, s)}#${s.name}`);
    process.exit(1);
  }
  r = db.prepare("SELECT * FROM node WHERE key=? LIMIT 1").get(p);
  if (r) return r;
  console.log(`no file or symbol "${arg}" in the graph`);
  process.exit(1);
}
const fileOf = (db, n) => (n.file_id ? db.prepare("SELECT key FROM node WHERE id=?").get(n.file_id)?.key : null);
function label(db, n) {
  if (!n) return "?";
  if (n.kind === KIND.symbol) return `${fileOf(db, n)}#${n.name}`;
  if (n.kind === KIND.file || n.kind === KIND.dir || n.kind === KIND.module) return n.key;
  if (n.kind === KIND.area) return `area ${n.name}${n.flags & FLAG.inferred ? " (inferred)" : ""}`;
  return `${KIND_NAME[n.kind]} ${n.key.length > 14 ? n.key.slice(0, 14) : n.key}: ${String(n.name || "").slice(0, 80)}`;
}
const byId = (db, id) => db.prepare("SELECT * FROM node WHERE id=?").get(id);
const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  return s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

function status(cwd) {
  if (!loadSqlite()) return console.log("graph: unavailable (needs Node 22.13+ with node:sqlite)");
  const file = currentDbFile(cwd);
  const lock = readLock(cwd);
  if (!file || !existsSync(file)) {
    console.log(`graph: not built. Run: ${cli()} graph build`);
    if (lockFresh(lock)) console.log(`a worker is running (pid ${lock.pid}, ${lock.mode}, since ${ago(lock.at)})`);
    return;
  }
  const db = openRead(cwd, { allowBuilding: true });
  if (!db) return console.log(`graph: ${file} exists but can't be opened (locked, corrupt or an old schema); \`graph build --full\` rebuilds it`);
  const st = metaJson(db, "stats") || {};
  const prog = metaJson(db, "progress") || {};
  const size = (f) => (existsSync(f) ? statSync(f).size : 0);
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  console.log(`graph: ${meta(db, "build_state")}  (${file})`);
  console.log(`  size ${mb(size(file))}, wal ${mb(size(file + "-wal"))}`);
  if (prog.phase && prog.phase !== "done") console.log(`  progress: ${prog.phase}${prog.total ? ` ${prog.done}/${prog.total}` : ""}`);
  const nodes = st.nodes || {};
  console.log(`  nodes: ${Object.entries(nodes).map(([k, n]) => `${KIND_NAME[k]} ${n}`).join(", ")}`);
  console.log(`  edges: ${Object.entries(st.edges || {}).map(([k, n]) => `${EDGE_NAME[k]} ${n}`).join(", ")}`);
  if (st.imports) console.log(`  imports resolved: ${st.imports - (st.unresolved || 0)}/${st.imports} (${Math.round(((st.imports - (st.unresolved || 0)) / st.imports) * 100)}%)`);
  const roles = db.prepare("SELECT role, count(*) AS n FROM node WHERE kind=1 AND (flags & 1) = 0 GROUP BY role").all();
  console.log(`  files by role: ${roles.map((r) => `${ROLE_NAME[r.role]} ${r.n}`).join(", ")}`);
  console.log(`  indexed at ${meta(db, "indexed_head")?.slice(0, 10) || "?"}; co-change at ${meta(db, "cochange_head")?.slice(0, 10) || "?"}${meta(db, "cochange_built_at") ? ` (${ago(Number(meta(db, "cochange_built_at")))})` : ""}`);
  if (st.last_build_ms) console.log(`  last full build ${(st.last_build_ms / 1000).toFixed(1)} s; last update ${st.last_update_ms ? (st.last_update_ms / 1000).toFixed(1) + " s" : "-"}${st.at ? `, ${ago(st.at)}` : ""}`);
  console.log(`  worker: ${lockFresh(lock) ? `running (pid ${lock.pid}, ${lock.mode}, since ${ago(lock.at)})` : "idle"}; log ${graphPaths(cwd).log}`);
}

function neighbors(cwd, args, opt) {
  const db = need(cwd);
  const n = findNode(db, cwd, args[0]);
  const limit = Number(opt("limit") || 15);
  const only = opt("type") ? EDGE[opt("type")] : null;
  console.log(label(db, n));
  const out = db.prepare(`SELECT type, dst AS v, w FROM edge WHERE src=? ${only ? "AND type=?" : ""} ORDER BY type, w DESC`).all(...[n.id, only].filter((x) => x != null));
  const inn = db.prepare(`SELECT type, src AS v, w FROM edge WHERE dst=? ${only ? "AND type=?" : ""} ORDER BY type, w DESC`).all(...[n.id, only].filter((x) => x != null));
  const group = (rows, dir) => {
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.type)) by.set(r.type, []);
      by.get(r.type).push(r);
    }
    for (const [t, list] of by) {
      if (t === EDGE.co_changed && dir === "in") continue; // stored both ways
      console.log(`  ${dir === "out" ? "→" : "←"} ${EDGE_NAME[t]} (${list.length})`);
      for (const r of list.slice(0, limit)) console.log(`      ${r.w < 1 ? r.w.toFixed(2) + " " : ""}${label(db, byId(db, r.v))}`);
      if (list.length > limit) console.log(`      … ${list.length - limit} more`);
    }
  };
  group(out, "out");
  group(inn, "in");
  if (n.kind === KIND.file) {
    const syms = db.prepare("SELECT name, line FROM node WHERE kind=4 AND file_id=? ORDER BY line").all(n.id);
    if (syms.length) console.log(`  defines (${syms.length}): ${syms.slice(0, 30).map((s) => s.name).join(", ")}${syms.length > 30 ? ", …" : ""}`);
  }
}

// What depends on a file, transitively, and what knows about it.
export function impactOf(db, id, { depth = 4, max = 500 } = {}) {
  const levels = [];
  const seen = new Set([id]);
  let wave = [id];
  const importers = db.prepare("SELECT DISTINCT src FROM edge WHERE dst=? AND type IN (?,?)");
  const symsOf = db.prepare("SELECT id FROM node WHERE file_id=?");
  for (let d = 1; d <= depth && wave.length && seen.size < max; d++) {
    const next = [];
    for (const u of wave) {
      const targets = [u, ...symsOf.all(u).map((s) => s.id)];
      for (const t of targets)
        for (const r of importers.all(t, EDGE.imports, EDGE.references)) {
          const n = byId(db, r.src);
          if (!n || n.kind !== KIND.file || seen.has(n.id)) continue;
          seen.add(n.id);
          next.push(n.id);
          if (seen.size >= max) break;
        }
    }
    if (next.length) levels.push(next);
    wave = next;
  }
  const all = [id, ...levels.flat()];
  const tests = new Set();
  const testQ = db.prepare("SELECT src FROM edge WHERE dst=? AND type=?");
  for (const f of all) for (const r of testQ.all(f, EDGE.tests)) tests.add(r.src);
  const docs = new Set(db.prepare("SELECT src FROM edge WHERE dst=? AND type=?").all(id, EDGE.documents).map((r) => r.src));
  const co = db.prepare("SELECT dst, w FROM edge WHERE src=? AND type=? ORDER BY w DESC LIMIT 10").all(id, EDGE.co_changed);
  const memQ = db.prepare(
    "SELECT DISTINCT e.src FROM edge e JOIN node m ON m.id = e.src WHERE e.dst=? AND e.type IN (?,?,?) AND m.kind IN (?,?,?,?)",
  );
  const memory = new Set();
  for (const f of all.slice(0, 50)) for (const r of memQ.all(f, EDGE.cites, EDGE.mentions, EDGE.touched, KIND.learning, KIND.decision, KIND.thread, KIND.checkpoint)) memory.add(r.src);
  return { levels, tests: [...tests], docs: [...docs], co, memory: [...memory], files: all };
}

function impact(cwd, args) {
  const db = need(cwd);
  const n = findNode(db, cwd, args[0]);
  const fid = n.kind === KIND.symbol ? n.file_id : n.id;
  const r = impactOf(db, fid);
  console.log(`Impact of ${label(db, n)}`);
  r.levels.forEach((lv, i) => {
    console.log(`  depends on it, ${i === 0 ? "directly" : `${i + 1} steps away`} (${lv.length}):`);
    for (const id of lv.slice(0, 20)) console.log(`      ${label(db, byId(db, id))}`);
    if (lv.length > 20) console.log(`      … ${lv.length - 20} more`);
  });
  if (!r.levels.length) console.log("  nothing imports it");
  if (r.tests.length) console.log(`  tests covering it or its dependents (${r.tests.length}):\n${r.tests.slice(0, 20).map((id) => "      " + label(db, byId(db, id))).join("\n")}`);
  if (r.docs.length) console.log(`  docs about it: ${r.docs.map((id) => label(db, byId(db, id))).join(", ")}`);
  if (r.co.length) console.log(`  usually changes with: ${r.co.map((c) => `${label(db, byId(db, c.dst))} (${Math.round(c.w * 100)}%)`).join(", ")}`);
  if (r.memory.length) console.log(`  memory about it (${r.memory.length}):\n${r.memory.slice(0, 15).map((id) => "      " + label(db, byId(db, id))).join("\n")}`);
}

async function query(cwd, args, opt) {
  const db = need(cwd);
  const text = args.join(" ");
  const files = (opt("files") || "").split(",").filter(Boolean);
  const { queryTerms } = await import("../rank.mjs");
  const terms = queryTerms(text);
  const named = text.match(/[\w./-]+\.[A-Za-z]{1,6}\b/g) || [];
  const t0 = performance.now();
  const { seeds, label: sl } = resolveSeeds(db, { editedFiles: files, files: named, text, terms });
  console.log(`terms: ${terms.join(" ") || "-"}; identifiers: ${codeIdents(text).join(" ") || "-"}`);
  console.log(`seeds (${seeds.size}):`);
  for (const [id, m] of [...seeds].sort((a, b) => b[1] - a[1])) console.log(`  ${m.toFixed(2)}  ${label(db, byId(db, id))}  (${sl.get(id)})`);
  if (!seeds.size) return console.log("no seeds: recall falls back to text matching only");
  const act = activate(db, seeds, graphConfig(cwd).query);
  const ms = performance.now() - t0;
  const ranked = [...act.A].filter(([id]) => !seeds.has(id)).sort((a, b) => b[1] - a[1]);
  const code = ranked.filter(([id]) => [KIND.file, KIND.symbol].includes(act.info.get(id)?.kind)).slice(0, 12);
  console.log(`\nactivated code (top ${code.length}):`);
  for (const [id, a] of code) console.log(`  ${a.toFixed(3)}  ${label(db, byId(db, id))}`);
  const mem = ranked.filter(([id]) => [KIND.learning, KIND.checkpoint, KIND.thread, KIND.decision, KIND.job].includes(act.info.get(id)?.kind)).slice(0, 15);
  console.log(`\nmemory (g = graph strength; 1 = cites what you're in; recall needs lexical + 3·min(${graphConfig(cwd).query.graphCap}, g) ≥ 3):`);
  for (const [id, g] of mem) {
    const n = byId(db, id);
    const w = why(db, id, act, sl);
    console.log(`  g=${g.toFixed(2)}  ${label(db, n)}${w ? `\n           via ${w}` : ""}`);
  }
  console.log(`\n${act.steps} lookups in ${ms.toFixed(1)} ms${act.timedOut ? " (stopped at the time budget)" : ""}`);
}

function explain(cwd, args) {
  const db = need(cwd);
  const key = args[0];
  const n = db.prepare("SELECT * FROM node WHERE kind=? AND (key=? OR data LIKE ?)").get(KIND.learning, key, `%"${key}"%`);
  if (!n) return console.log(`no learning ${key} in the graph (it may be newer than the last update)`);
  const d = JSON.parse(n.data);
  console.log(`${n.key}: ${d.text}`);
  console.log(`  sources: ${(d.sources || []).join(", ") || "manual"}; corroborated ${d.corroborations}×; verified ${d.last_verified_at}`);
  const out = db.prepare("SELECT type, dst FROM edge WHERE src=?").all(n.id);
  for (const r of out) {
    const t = byId(db, r.dst);
    const gone = t.flags & FLAG.deleted ? "  [no longer exists]" : "";
    console.log(`  ${EDGE_NAME[r.type]} ${label(db, t)}${gone}`);
  }
  for (const [ref, base] of Object.entries(d.sym_refs || {})) {
    const [path, name] = ref.split("#");
    const f = db.prepare("SELECT id FROM node WHERE kind=1 AND key=?").get(path);
    const s = f && db.prepare("SELECT hash, hash2 FROM node WHERE kind=4 AND file_id=? AND name=?").get(f.id, name);
    const [h] = String(base).split("|");
    console.log(`  symbol ${ref}: ${!s ? "not defined there now" : s.hash === h ? "unchanged since recorded" : "its definition changed since recorded"}`);
  }
  // Files that would recall it: its cited files' strongest neighbours.
  const cited = out.filter((r) => r.type === EDGE.cites).map((r) => r.dst);
  const near = new Map();
  for (const c of cited)
    for (const r of db.prepare("SELECT dst, w FROM edge WHERE src=? AND type=? ORDER BY w DESC LIMIT 8").all(c, EDGE.co_changed)) near.set(r.dst, Math.max(near.get(r.dst) || 0, r.w));
  if (near.size) console.log(`  also recalled from (co-change): ${[...near].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, w]) => `${label(db, byId(db, id))} ${Math.round(w * 100)}%`).join(", ")}`);
}

// Strongest path: Dijkstra with cost -ln(weight) over code edges, at most 6 hops.
function path(cwd, args) {
  const db = need(cwd);
  const a = findNode(db, cwd, args[0]);
  const b = findNode(db, cwd, args[1]);
  const types = [EDGE.imports, EDGE.co_changed, EDGE.references, EDGE.tests, EDGE.documents, EDGE.contains];
  const outQ = db.prepare(`SELECT dst AS v, type, w FROM edge WHERE src=? AND type IN (${types.join(",")}) ORDER BY w DESC LIMIT 60`);
  const inQ = db.prepare(`SELECT src AS v, type, w FROM edge WHERE dst=? AND type IN (${types.join(",")}) ORDER BY w DESC LIMIT 60`);
  const dist = new Map([[a.id, 0]]);
  const prev = new Map();
  const hops = new Map([[a.id, 0]]);
  const open = [[0, a.id]];
  let found = false;
  let pops = 0;
  while (open.length && pops++ < 20000) {
    open.sort((x, y) => x[0] - y[0]);
    const [d, u] = open.shift();
    if (u === b.id) {
      found = true;
      break;
    }
    if (d > dist.get(u) || hops.get(u) >= 6) continue;
    const nu = byId(db, u);
    const extra = nu.kind === KIND.symbol && nu.file_id ? [{ v: nu.file_id, type: 0, w: 1, dir: "defined in" }] : [];
    for (const r of [...extra, ...outQ.all(u).map((r) => ({ ...r, dir: "→" })), ...inQ.all(u).map((r) => ({ ...r, dir: "←" }))]) {
      const nd = d - Math.log(Math.max(0.01, r.w)) + (r.type === EDGE.contains ? 2 : 0.1);
      if (nd < (dist.get(r.v) ?? Infinity)) {
        dist.set(r.v, nd);
        prev.set(r.v, { u, ...r });
        hops.set(r.v, hops.get(u) + 1);
        open.push([nd, r.v]);
      }
    }
  }
  if (!found) return console.log(`no path within 6 steps between ${label(db, a)} and ${label(db, b)}`);
  const steps = [];
  for (let v = b.id; v !== a.id; v = prev.get(v).u) steps.unshift(prev.get(v));
  console.log(label(db, a));
  for (const s of steps) console.log(`  ${s.dir} ${s.type ? EDGE_NAME[s.type] : ""}${s.w < 1 ? ` ${s.w.toFixed(2)}` : ""}  ${label(db, byId(db, s.v))}`);
}

function areas(cwd) {
  const db = need(cwd);
  const rows = db.prepare("SELECT id, name, flags FROM node WHERE kind=? ORDER BY name").all(KIND.area);
  if (!rows.length) return console.log("no areas (docs/AREAS.md absent and none inferred yet)");
  console.log("## Area → owned paths\n\n| Area | Owned paths | Doc |\n|---|---|---|");
  for (const a of rows) {
    const files = db.prepare("SELECT n.key FROM edge e JOIN node n ON n.id = e.dst WHERE e.src=? AND e.type=?").all(a.id, EDGE.owns).map((r) => r.key);
    const dirs = new Map();
    for (const f of files) {
      const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : f;
      dirs.set(d, (dirs.get(d) || 0) + 1);
    }
    const cells = [...dirs].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([d]) => `\`${d}\``);
    console.log(`| **${a.name}**${a.flags & FLAG.inferred ? " (inferred)" : ""} | ${cells.join(" · ")}${dirs.size > 6 ? " …" : ""} | Not yet written up |`);
  }
}

function exportGraph(cwd, opt, flag) {
  const db = need(cwd);
  const limit = Number(opt("limit") || 2000);
  const types = (opt("types") || "imports,co_changed").split(",").map((t) => EDGE[t.trim()]).filter(Boolean);
  let edges;
  if (opt("root")) {
    const r = findNode(db, cwd, opt("root"));
    const depth = Number(opt("depth") || 2);
    const seen = new Set([r.id]);
    let wave = [r.id];
    edges = [];
    const q = db.prepare(`SELECT src, dst, type, w FROM edge WHERE (src=?1 OR dst=?1) AND type IN (${types.join(",")}) LIMIT 200`);
    for (let d = 0; d < depth && wave.length && edges.length < limit; d++) {
      const next = [];
      for (const u of wave)
        for (const e of q.all(u)) {
          edges.push(e);
          const v = e.src === u ? e.dst : e.src;
          if (!seen.has(v)) seen.add(v), next.push(v);
        }
      wave = next;
    }
  } else edges = db.prepare(`SELECT src, dst, type, w FROM edge WHERE type IN (${types.join(",")}) ORDER BY w DESC LIMIT ?`).all(limit);
  edges = edges.slice(0, limit);
  const ids = new Set(edges.flatMap((e) => [e.src, e.dst]));
  const nodes = [...ids].map((id) => byId(db, id)).filter(Boolean);
  if (flag("json")) {
    console.log(JSON.stringify({ nodes: nodes.map((n) => ({ id: n.id, kind: KIND_NAME[n.kind], key: n.key, name: n.name })), edges: edges.map((e) => ({ ...e, type: EDGE_NAME[e.type] })) }));
    return;
  }
  console.log("digraph cairn {\n  rankdir=LR; node [shape=box, fontsize=10];");
  for (const n of nodes) console.log(`  n${n.id} [label=${JSON.stringify(label(db, n))}];`);
  for (const e of edges) console.log(`  n${e.src} -> n${e.dst} [label="${EDGE_NAME[e.type]}${e.w < 1 ? " " + e.w.toFixed(2) : ""}"${e.type === EDGE.co_changed ? ", style=dashed, dir=none" : ""}];`);
  console.log("}");
}

export async function graphCli(cwd, args, { opt, flag }) {
  const [sub, ...rest] = args;
  const pos = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--") && !["--fg", "--full", "--quiet", "--json", "--dot"].includes(rest[i - 1])));
  switch (sub) {
    case "build":
    case "update": {
      const mode = sub === "build" ? (flag("full") ? "full" : "auto") : opt("mode") || "auto";
      if (sub === "build" && !flag("fg")) {
        if (!loadSqlite()) return console.log("The graph needs Node 22.13+ (node:sqlite with FTS5).");
        if (lockFresh(readLock(cwd))) return console.log("A graph update is already running; `graph status` shows progress.");
        const pid = spawnWorker(cwd, mode);
        return console.log(`Graph ${mode === "full" ? "rebuild" : "build"} started in the background (pid ${pid}). Watch it with: ${cli()} graph status`);
      }
      const { runWorker } = await import("./worker.mjs");
      const r = await runWorker(cwd, { mode, quiet: flag("quiet"), fg: flag("fg") || sub === "build" });
      if (!flag("quiet")) console.log(JSON.stringify(r, null, 1));
      return;
    }
    case "status":
      return status(cwd);
    case "neighbors":
    case "neighbours":
      return neighbors(cwd, pos, opt);
    case "impact":
      return impact(cwd, pos);
    case "query":
      return query(cwd, pos, opt);
    case "explain":
      return explain(cwd, pos);
    case "path":
      return path(cwd, pos);
    case "areas":
      return areas(cwd);
    case "export":
      return exportGraph(cwd, opt, flag);
    case "bench": {
      const { bench } = await import("./bench.mjs");
      return bench(cwd, { repo: opt("repo"), queries: Number(opt("queries") || 200) });
    }
    default:
      console.log(USAGE);
      process.exitCode = sub ? 1 : 0;
  }
}

