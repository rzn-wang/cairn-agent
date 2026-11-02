// What the hooks ask the graph. Read-only, synchronous, bounded in time, and null on any problem, in which case
// the caller does exactly what it did before the graph existed.

import { join } from "node:path";
import { dataDir, markStale, repoRoot } from "../store.mjs";
import { meta, metaJson, openRead } from "./db.mjs";
import { graphConfig } from "./gconfig.mjs";
import { fileSig } from "./memory.mjs";
import { activate, resolveSeeds, why } from "./query.mjs";
import { symbolStaleness } from "./symbols.mjs";
import { EDGE, FLAG, KIND } from "./schema.mjs";

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// The folded learnings as stored by the worker, when they match learnings.jsonl as it is now. Saves re-folding
// the whole file on every prompt. Same shape as store.recallable().
export function mirrorLearnings(cwd, db = openRead(cwd)) {
  return safe(() => {
    if (!db) return null;
    const was = metaJson(db, "sig:learnings");
    const now = fileSig(join(dataDir(cwd), "learnings.jsonl"));
    if (!was || was.size !== now.size || was.mtimeMs !== now.mtimeMs) return null;
    const rows = db
      .prepare("SELECT data FROM node WHERE kind=?")
      .all(KIND.learning)
      .map((r) => {
        const l = JSON.parse(r.data);
        l.keys = new Set(l.keys || [l.key]);
        return l;
      })
      .sort((a, b) => (a.last_verified_at < b.last_verified_at ? 1 : -1));
    return symbolStaleness(db, markStale(rows, repoRoot(cwd)));
  });
}

// Decayed churn for the given paths (replaces a `git log` per prompt).
export function graphChurn(cwd, paths, db = openRead(cwd)) {
  return safe(() => {
    if (!db || !paths?.length) return db ? new Map() : null;
    const q = db.prepare("SELECT churn FROM node WHERE kind=1 AND key=?");
    const out = new Map();
    for (const p of new Set(paths)) {
      const c = q.get(p)?.churn;
      if (c != null) out.set(p, c);
    }
    return out;
  });
}

// { learnings: Map key -> { g, why }, checkpoints: Map key -> { g, why }, others: Map "kind:key" -> { g, why,
// kind, name } for threads, decisions and jobs, mirror } or null.
export function graphRecall(cwd, { text = "", terms = [], files = [], editedFiles = [] } = {}) {
  const db = openRead(cwd);
  if (!db) return null;
  return safe(() => {
    const cfg = graphConfig(cwd).query;
    const { seeds, label, loose } = resolveSeeds(db, { editedFiles, files, text, terms });
    const learnings = new Map();
    const checkpoints = new Map();
    const others = new Map();
    let stats = null;
    // Word-only seeds add no memory: the lexical scorers already weigh shared words, and a word that happens to
    // be part of a code name ("time" -> TIME_PRESETS) pulled in unrelated checkpoints at full strength.
    if (seeds.size && !loose) {
      const act = activate(db, seeds, cfg);
      stats = { steps: act.steps, ms: act.ms, timedOut: act.timedOut, seeds: seeds.size };
      for (const [id, g] of act.A) {
        const n = act.info.get(id);
        if (!n || g < 0.05) continue;
        const entry = () => ({ g, why: why(db, id, act, label), id });
        if (n.kind === KIND.learning) learnings.set(n.key, entry());
        else if (n.kind === KIND.checkpoint) checkpoints.set(n.key, entry());
        else if (n.kind === KIND.thread || n.kind === KIND.decision || n.kind === KIND.job) others.set(`${n.kind}:${n.key}`, { ...entry(), kind: n.kind, name: n.name });
      }
    }
    return { learnings, checkpoints, others, mirror: mirrorLearnings(cwd, db), stats, cap: cfg.graphCap, scale: cfg.graphScale };
  });
}

// Files near what a query names (paths, identifiers, words), for routing: Map path -> activation.
export function fileProximity(cwd, { text = "", files = [], terms = [] } = {}) {
  const db = openRead(cwd);
  if (!db) return null;
  return safe(() => {
    const { seeds } = resolveSeeds(db, { files, text, terms });
    if (!seeds.size) return new Map();
    const act = activate(db, seeds, { ...graphConfig(cwd).query, hops: 2 });
    const out = new Map();
    for (const [id, a] of act.A) {
      const n = act.info.get(id) || db.prepare("SELECT kind, key FROM node WHERE id=?").get(id);
      if (n?.kind === KIND.file) out.set(n.key, a);
    }
    return out;
  });
}

// How strongly `file` is tied to each of `others` (repo paths): co-change, imports either way, tests.
// Returns [{ path, c, how }] for ties of at least `min`, strongest first.
export function coupling(cwd, file, others, { min } = {}) {
  const db = openRead(cwd);
  if (!db || !others?.length) return [];
  return safe(() => {
    const floor = min ?? graphConfig(cwd).coupling.min;
    const id = db.prepare("SELECT id FROM node WHERE kind=1 AND key=?").get(file)?.id;
    if (!id) return [];
    const q = db.prepare(
      "SELECT n.key AS path, e.type AS type, e.w AS w, (e.src = ?1) AS out FROM edge e JOIN node n ON n.id = (CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END) " +
        "WHERE (e.src = ?1 OR e.dst = ?1) AND e.type IN (?2, ?3, ?4) AND n.kind = 1 AND n.key IN (SELECT value FROM json_each(?5))",
    );
    const best = new Map();
    for (const r of q.all(id, EDGE.co_changed, EDGE.imports, EDGE.tests, JSON.stringify(others))) {
      let c = 0;
      let how = "";
      if (r.type === EDGE.co_changed) (c = r.w), (how = `changes with it in ${Math.round(r.w * 100)}% of commits`);
      else if (r.type === EDGE.imports) (c = r.out ? 0.6 : 0.5), (how = r.out ? "your file imports it" : "it imports your file");
      else if (r.type === EDGE.tests) (c = 0.4), (how = r.out ? "your file tests it" : "it tests your file");
      if (c >= floor && (!best.has(r.path) || best.get(r.path).c < c)) best.set(r.path, { path: r.path, c, how });
    }
    return [...best.values()].sort((a, b) => b.c - a.c);
  }, []);
}

// The inferred area holding `file` (when the repo has no docs/AREAS.md): { name, members: [paths] } or null.
export function inferredAreaOf(cwd, file, { limit = 40 } = {}) {
  const db = openRead(cwd);
  if (!db) return null;
  return safe(() => {
    const a = db
      .prepare(
        "SELECT a.id, a.name FROM node f JOIN edge e ON e.dst = f.id AND e.type = ? JOIN node a ON a.id = e.src AND a.kind = ? AND (a.flags & ?) <> 0 WHERE f.kind = 1 AND f.key = ?",
      )
      .get(EDGE.owns, KIND.area, FLAG.inferred, file);
    if (!a) return null;
    const members = db
      .prepare("SELECT n.key FROM edge e JOIN node n ON n.id = e.dst WHERE e.src = ? AND e.type = ? ORDER BY n.churn DESC NULLS LAST LIMIT ?")
      .all(a.id, EDGE.owns, limit)
      .map((r) => r.key);
    return { name: a.name, members };
  });
}

// One line for the seed while a first build runs, or null.
export function buildingNote(cwd) {
  return safe(() => {
    const db = openRead(cwd, { allowBuilding: true });
    if (!db || meta(db, "build_state") !== "building") return null;
    const p = metaJson(db, "progress");
    return `The repo's knowledge graph is still being built${p?.phase ? ` (${p.phase}${p.total ? ` ${p.done}/${p.total}` : ""})` : ""}; recall is text-only until it's ready.`;
  });
}
