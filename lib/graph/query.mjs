// Graph retrieval: from what's in play (edited files, paths and identifiers in the prompt, matching names) to the
// memory worth recalling. Bounded spreading activation, a truncated personalised PageRank: mass starts on the
// seeds and flows a few hops along weighted, typed edges; memory nodes (learnings, checkpoints, threads,
// decisions, jobs) collect it and pass none on. Every step is an indexed lookup with a LIMIT, and the whole walk
// stops at a time budget, so a hub file imported by 5,000 others costs the same as a leaf.
//
// Scale: a seed has mass 1 and a fact citing it receives 1 (cites carry weight 1 and are not diluted), so a
// memory node's activation reads directly as "how strongly is this tied to what you're doing" with 1 = it cites
// your file. One co-change hop at weight 0.6 gives about 0.35.

import { EDGE, KIND, MEMORY } from "./schema.mjs";

// [type, direction, alpha]. "out" follows src -> dst, "in" dst -> src.
export const DEFAULT_WEIGHTS = {
  // Tuned on held-out commits of django and express (graph bench): imports at about half of co-change, with
  // fan-out diluted by W^0.75, predicted the next commit's files best (django recall@20 29% → 40%).
  imports: { out: 0.25, in: 0.15 },
  references: { out: 0.2, in: 0.2 },
  co_changed: { out: 0.85 },
  contains: { out: 0.05, in: 0.15 },
  cites: { in: 1.0 },
  mentions: { in: 0.6, out: 0.3 },
  touched: { in: 0.8 },
  owns: { out: 0.05, in: 0.3 },
  tests: { out: 0.3, in: 0.5 },
  documents: { out: 0.4, in: 0.6 },
  job_file: { in: 0.5 },
  decided_in: { in: 0.4 },
  edited: { in: 0.6 },
  planned: { in: 0.4 },
};
// Which edges a node of each kind spreads along.
const FROM = {
  [KIND.file]: ["imports", "references", "co_changed", "contains", "cites", "mentions", "touched", "owns", "tests", "documents", "job_file", "decided_in"],
  [KIND.symbol]: ["references", "cites", "mentions"],
  [KIND.dir]: ["contains"],
  [KIND.module]: ["imports"],
  [KIND.area]: ["owns"],
};
const SESSION_EDGES = ["edited", "planned"];

function buildPlan(weights, withSessions) {
  const plan = {};
  for (const [kind, names] of Object.entries(FROM)) {
    const list = [];
    for (const name of withSessions && Number(kind) === KIND.file ? [...names, ...SESSION_EDGES] : names) {
      const wt = weights[name] || {};
      if (wt.out) list.push({ type: EDGE[name], dir: "out", alpha: wt.out, name });
      if (wt.in) list.push({ type: EDGE[name], dir: "in", alpha: wt.in, name });
    }
    plan[kind] = list;
  }
  return plan;
}

const stmtCache = new WeakMap();
function stmts(db) {
  let s = stmtCache.get(db);
  if (s) return s;
  s = {
    out: db.prepare("SELECT dst AS v, w FROM edge WHERE src=? AND type=? ORDER BY w DESC LIMIT ?"),
    in: db.prepare("SELECT src AS v, w FROM edge WHERE dst=? AND type=? ORDER BY w DESC LIMIT ?"),
    // All of a node's outgoing edges in one read (out-degree is bounded at build time), and its incoming edges
    // except imports/references (whose fan-in can be thousands; those are read per type with a LIMIT).
    outAll: db.prepare("SELECT dst AS v, type, w FROM edge WHERE src=? ORDER BY type, w DESC LIMIT 800"),
    inSmall: db.prepare(`SELECT src AS v, type, w FROM edge WHERE dst=? AND type NOT IN (${EDGE.imports}, ${EDGE.references}, ${EDGE.in_commit}, ${EDGE.contains}) ORDER BY type, w DESC LIMIT 600`),
    node: db.prepare("SELECT id, kind, key, name, file_id, deg_in, flags, role FROM node WHERE id=?"),
    fileByKey: db.prepare("SELECT id FROM node WHERE kind=1 AND key=?"),
    fileByName: db.prepare("SELECT id, key FROM node WHERE kind=1 AND lname=? AND (flags & 1) = 0 LIMIT 50"),
    // By lname (indexed); exact-case matches are preferred in JS.
    symByLname: db.prepare("SELECT id, key, file_id, name FROM node WHERE kind=4 AND lname=? LIMIT 20"),
    ftsIdent: db.prepare("SELECT node, bm25(fts_ident) AS r FROM fts_ident WHERE fts_ident MATCH ? ORDER BY r LIMIT ?"),
    ftsMem: db.prepare("SELECT node, kind, bm25(fts_mem) AS r FROM fts_mem WHERE fts_mem MATCH ? ORDER BY r LIMIT ?"),
  };
  stmtCache.set(db, s);
  return s;
}

export function nodeInfo(db, id, cache = new Map()) {
  if (!cache.has(id)) cache.set(id, stmts(db).node.get(id) || null);
  return cache.get(id);
}

// Identifiers a person would type for code: camelCase, PascalCase, snake_case with 2+ parts, or `backticked`.
export function codeIdents(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)) out.add(m[1]);
  for (const m of String(text || "").matchAll(/\b([a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[a-z0-9]+_[a-z0-9_]+|[A-Z][a-zA-Z0-9]{3,})\b/g)) out.add(m[1]);
  return [...out].slice(0, 20);
}

const ftsQuote = (t) => `"${String(t).replace(/"/g, '""')}"`;

// Seeds: Map node id -> mass (max 1), plus labels for the why. `loose` is true when every seed came only from a
// plain word of the request matching a code name ("enemy" -> ENEMY_DROPS, "build" -> build()): no file named or
// edited, no identifier typed. Those are guesses, fine for routing but too weak to recall memory on their own.
export function resolveSeeds(db, { editedFiles = [], files = [], text = "", terms = [] } = {}) {
  const s = stmts(db);
  const seeds = new Map();
  const label = new Map();
  const add = (id, m, why) => {
    if (!id) return;
    if ((seeds.get(id) || 0) < m) {
      seeds.set(id, m);
      label.set(id, why);
    }
  };
  editedFiles.slice(0, 10).forEach((p, i) => add(s.fileByKey.get(p)?.id, Math.pow(0.8, i), "you edited it"));
  for (const raw of files.slice(0, 10)) {
    const p = String(raw).replace(/\\/g, "/").replace(/^\.\//, "");
    const exact = s.fileByKey.get(p)?.id;
    if (exact) {
      add(exact, 1.5, "named in the request");
      continue;
    }
    const base = p.split("/").pop().toLowerCase();
    const hits = s.fileByName.all(base).filter((r) => r.key === p || r.key.endsWith("/" + p));
    const pick = hits.slice(0, 3);
    for (const h of pick) add(h.id, 1.5 / pick.length, "named in the request");
  }
  for (const ident of codeIdents(text)) {
    const all = s.symByLname.all(ident.toLowerCase());
    const exact = all.filter((h) => h.name === ident);
    const hits = exact.length ? exact : all;
    const pick = hits.slice(0, 3);
    for (const h of pick) add(h.id, 1.5 / pick.length, `\`${ident}\` named in the request`);
  }
  const strong = seeds.size;
  const words = terms.filter((t) => /^[a-z0-9_]{3,}$/i.test(t)).slice(0, 12);
  if (words.length) {
    try {
      const rows = s.ftsIdent.all(words.map(ftsQuote).join(" OR "), 5);
      const best = rows.length ? Math.min(...rows.map((r) => r.r)) : 0;
      for (const r of rows) add(r.node, 0.5 * (best ? r.r / best : 1), "its name matches the request");
    } catch {
      /* odd query text: no name seeds */
    }
  }
  let max = 0;
  for (const m of seeds.values()) max = Math.max(max, m);
  if (max > 0) for (const [k, m] of seeds) seeds.set(k, m / max);
  return { seeds, label, loose: strong === 0 && seeds.size > 0 };
}

// Memory nodes whose text matches the terms (stemmed full-text search), as candidates for the lexical scorers.
export function textCandidates(db, terms, limit = 50) {
  const words = terms.filter((t) => /^[a-z0-9_]{3,}$/i.test(t)).slice(0, 16);
  if (!words.length) return [];
  try {
    return stmts(db).ftsMem.all(words.map(ftsQuote).join(" OR "), limit);
  } catch {
    return [];
  }
}

export function activate(db, seeds, { hops = 3, frontier = 64, fanout = 24, budgetMs = 40, beta = 0.75, weights = {}, withSessions = false } = {}) {
  const s = stmts(db);
  const plan = buildPlan({ ...DEFAULT_WEIGHTS, ...weights }, withSessions);
  const info = new Map();
  const A = new Map(seeds);
  const pred = new Map();
  let wave = new Map(seeds);
  const t0 = performance.now();
  let steps = 0;
  let timedOut = false;
  for (let h = 1; h <= hops && wave.size; h++) {
    const next = new Map();
    const front = [...wave].filter(([id]) => {
      const n = nodeInfo(db, id, info);
      return n && !MEMORY.has(n.kind) && n.kind !== KIND.session && n.kind !== KIND.commit;
    });
    front.sort((a, b) => b[1] - a[1]);
    for (const [u, mass] of front.slice(0, frontier)) {
      const nu = nodeInfo(db, u, info);
      const routes = [...(plan[nu.kind] || [])];
      if (nu.kind === KIND.symbol && nu.file_id) {
        // A symbol passes most of its mass to the file that defines it.
        const d = mass * 0.9;
        next.set(nu.file_id, (next.get(nu.file_id) || 0) + d);
        if (!pred.has(nu.file_id) || pred.get(nu.file_id).d < d) pred.set(nu.file_id, { u, name: "defines", w: 1, d });
      }
      // Group this node's edges by (type, direction): two reads, plus one per high-fan-in type it spreads along.
      const outBy = new Map();
      for (const row of s.outAll.all(u)) {
        let l = outBy.get(row.type);
        if (!l) outBy.set(row.type, (l = []));
        if (l.length < fanout) l.push(row);
      }
      const inBy = new Map();
      for (const row of s.inSmall.all(u)) {
        let l = inBy.get(row.type);
        if (!l) inBy.set(row.type, (l = []));
        if (l.length < fanout) l.push(row);
      }
      steps += 2;
      for (const r of routes) {
        if (performance.now() - t0 > budgetMs) {
          timedOut = true;
          break;
        }
        let rows;
        if (r.dir === "out") rows = outBy.get(r.type) || [];
        else if (r.type === EDGE.imports || r.type === EDGE.references || r.type === EDGE.contains) {
          rows = s.in.all(u, r.type, fanout);
          steps++;
        } else rows = inBy.get(r.type) || [];
        if (!rows.length) continue;
        let W = 0;
        for (const row of rows) W += row.w;
        for (const row of rows) {
          const nv = nodeInfo(db, row.v, info);
          if (!nv) continue;
          if (nv.kind === KIND.session && !withSessions) continue;
          // Into memory: undiluted (a fact citing your file gets your file's mass). Between code: diluted by fan-out.
          const sink = MEMORY.has(nv.kind) || nv.kind === KIND.session;
          const d = sink ? mass * r.alpha * row.w : (mass * r.alpha * row.w) / Math.pow(Math.max(1, W), beta);
          if (d < 1e-4) continue;
          if (seeds.has(row.v)) continue;
          next.set(row.v, (next.get(row.v) || 0) + d);
          if (!pred.has(row.v) || pred.get(row.v).d < d) pred.set(row.v, { u, name: r.name, dir: r.dir, w: row.w, d });
        }
      }
      if (timedOut) break;
    }
    let sum = 0;
    for (const [v, d] of next) {
      A.set(v, (A.get(v) || 0) + d);
      sum += d;
    }
    wave = next;
    if (timedOut || sum < 1e-3) break;
  }
  return { A, pred, info, steps, ms: performance.now() - t0, timedOut };
}

const base = (p) => String(p || "").split("/").pop();
function label1(n) {
  if (!n) return "?";
  if (n.kind === KIND.file) return n.key;
  if (n.kind === KIND.symbol) return `\`${n.name}\``;
  return n.name || n.key;
}

// How a memory node was reached, for the reader: "src/b.ts changes with a.ts (62% of commits); a.ts: you edited it".
// Empty when the fact cites a seed directly (the lexical match already says why).
export function why(db, id, { pred, info }, seedLabel) {
  const steps = [];
  let cur = id;
  for (let i = 0; i < 5; i++) {
    const p = pred.get(cur);
    if (!p) break;
    steps.push({ from: p.u, to: cur, ...p });
    cur = p.u;
  }
  const chain = steps.slice(1).reverse(); // seed outward, without the edge into the memory node
  if (!chain.length) return "";
  const phrase = (st) => {
    const a = label1(nodeInfo(db, st.from, info));
    const b = label1(nodeInfo(db, st.to, info));
    const out = st.dir === "out";
    switch (st.name) {
      case "co_changed":
        return `${b} changes with ${base(a)} (${Math.round(st.w * 100)}% of commits)`;
      case "imports":
        return out ? `${base(a)} imports ${b}` : `${b} imports ${base(a)}`;
      case "references":
        return out ? `${base(a)} uses ${b}` : `${b} uses ${base(a)}`;
      case "tests":
        return out ? `${base(a)} tests ${b}` : `${b} tests ${base(a)}`;
      case "documents":
        return out ? `${base(a)} documents ${b}` : `${b} documents ${base(a)}`;
      case "defines":
        return `${a} is defined in ${b}`;
      case "contains":
        return `${b} is in the same folder`;
      case "owns":
        return `${b} is in the same area`;
      default:
        return `${b} (${st.name} ${base(a)})`;
    }
  };
  const seed = nodeInfo(db, cur, info);
  const sl = seedLabel?.get(cur);
  return `${chain.map(phrase).join("; ")}${sl ? `; ${base(label1(seed))}: ${sl}` : ""}`;
}
