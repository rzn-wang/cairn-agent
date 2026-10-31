// Learning identity, folding and relevance ranking (docs/CAIRN.md).
// Pure functions only — no fs, no git, no clock beyond what callers pass in —
// so store.mjs, the seed builder and the hooks can all share one notion of
// "same fact" and "relevant fact".

import { createHash } from "node:crypto";

// Two learnings are the same fact when their normalized token sets overlap this
// much. 0.6 is deliberately loose: the miner re-derives the same fact from every
// commit touching the code, phrased slightly differently each time.
export const DUP_THRESHOLD = 0.6;

const STOP = new Set(
  (
    "the a an is are was were be been to of and or in on for it its that this with as at from by " +
    "not no must can will would should may might do does did has have had one two"
  ).split(" "),
);

export function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Stable, content-derived identity: survives union-merge across devs and gives
// `verify`/`forget` something to address (numeric ids are per-machine max+1 and
// therefore collide between clones).
export function learningKey(text) {
  return createHash("sha256").update(normalizeText(text)).digest("hex").slice(0, 12);
}

export function tokens(text) {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Fraction of the SHORTER fact contained in the longer one. Jaccard alone misses
// the miner's most common duplicate: the same fact restated at a different
// length. "Landing thump effects expire after LANDING_TTL" inside "Landing thump
// effects (drop, squash, dust) expire after LANDING_TTL … loses the visual
// feedback" scores containment 1.00 but Jaccard only 0.52, because Jaccard
// punishes the length gap.
export function containment(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

// The floor keeps very short facts from being swallowed by any longer text that
// happens to use the same handful of words.
const CONTAIN_THRESHOLD = 0.85;
const CONTAIN_MIN_TOKENS = 5;

export function sameFact(a, b) {
  if (jaccard(a, b) >= DUP_THRESHOLD) return true;
  return Math.min(a.size, b.size) >= CONTAIN_MIN_TOKENS && containment(a, b) >= CONTAIN_THRESHOLD;
}

const newest = (a, b) => (a && b ? (a > b ? a : b) : a || b);
const oldest = (a, b) => (a && b ? (a < b ? a : b) : a || b);

// rows (raw JSONL, facts + control rows) -> folded facts, newest-first by
// last_verified_at. Duplicates become ONE entry with corroborations>1 rather
// than N seed slots: a fact independently re-derived from a second commit is
// evidence it is durable, so it should rank higher, not repeat.
export function foldLearnings(rows) {
  const facts = [];
  const controls = [];
  for (const r of rows || []) {
    if (r && r.ctl) controls.push(r);
    else if (r && typeof r.text === "string") facts.push(r);
  }

  const clusters = [];
  const byKey = new Map();
  for (const row of facts) {
    const key = row.key || learningKey(row.text);
    const toks = tokens(row.text);
    let cluster = byKey.get(key);
    if (!cluster) {
      cluster = clusters.find((c) => sameFact(toks, c.tokens));
    }
    if (!cluster) {
      cluster = {
        key,
        keys: new Set([key]),
        tokens: toks,
        // the longest phrasing tends to be the most specific one
        text: row.text,
        id: row.id,
        refs: [],
        ref_hashes: {},
        sources: [],
        corroborations: 0,
        created_at: row.created_at,
        last_verified_at: row.last_verified_at || row.created_at,
        legacy_unverified: false,
      };
      clusters.push(cluster);
    }
    cluster.keys.add(key);
    byKey.set(key, cluster);

    if (row.text.length > cluster.text.length) {
      // Keep the fullest phrasing, and widen the cluster's token set with it so
      // later shorter restatements still match by containment.
      cluster.text = row.text;
      for (const t of toks) cluster.tokens.add(t);
    }
    cluster.corroborations++;
    for (const ref of row.refs || []) if (!cluster.refs.includes(ref)) cluster.refs.push(ref);
    Object.assign(cluster.ref_hashes, row.ref_hashes || {});
    if (row.source && !cluster.sources.includes(row.source)) cluster.sources.push(row.source);
    cluster.created_at = oldest(cluster.created_at, row.created_at);
    cluster.last_verified_at = newest(
      cluster.last_verified_at,
      row.last_verified_at || row.created_at,
    );
    // Pre-stale-lifecycle stores marked edited-file facts "unverified" and hid
    // them; they are re-admitted as ordinary facts (staleness is now derived).
    if (row.status === "unverified") cluster.legacy_unverified = true;
  }

  // Control rows are append-only edits: `retire` drops a fact for good,
  // `verify` re-baselines its ref hashes so derived staleness clears.
  const retired = new Set();
  for (const c of controls) {
    const cluster = byKey.get(c.key);
    if (!cluster) continue;
    if (c.ctl === "retire") retired.add(cluster);
    else if (c.ctl === "verify") {
      Object.assign(cluster.ref_hashes, c.ref_hashes || {});
      cluster.last_verified_at = newest(cluster.last_verified_at, c.at);
      cluster.legacy_unverified = false;
    }
  }

  return clusters
    .filter((c) => !retired.has(c))
    .sort((a, b) => (a.last_verified_at < b.last_verified_at ? 1 : -1));
}

// True when a commit touches nothing but the cairn store. Mining such a commit
// feeds the miner its own stored facts and it re-emits them as new ones.
export function isStoreOnlyChange(paths) {
  const p = (paths || []).filter((x) => x && x.trim());
  return p.length > 0 && p.every((x) => x.startsWith(".claude/cairn/"));
}

// Top-level subsystem of a repo-relative path, used for the diversity cap:
// src/sim/jobs/jobBoard.ts -> src/sim, docs/design/X.md -> docs/design.
export function subsystemOf(path) {
  const parts = String(path || "").split("/");
  return parts.slice(0, 2).join("/") || "(none)";
}

function pathTokens(path) {
  return new Set(
    String(path || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

// Relevance of each folded learning to what the session is actually doing.
// `files` are repo-relative paths in play (edited, or named in the prompt);
// `terms` are lowercased query words. Ref-path overlap is weighted highest
// because it is the one precise signal and was previously unused — `learnings
// jobBoard` used to miss every learning that merely CITES jobBoard.ts.
//
// `relevance` counts only topical evidence; `score` adds tiebreakers. Callers
// filter on relevance, so a well-corroborated but unrelated fact can never
// qualify on corroboration alone, and staleness can never hide a fact about the
// very file being edited — a stale learning about world.ts is MORE relevant when
// you are editing world.ts, not less.
// Churn at which the stale penalty is cut in half. A saturating curve, not
// `1 - churn`: real churn rates are compressed (this repo's hottest file sits
// near 0.35 because it commits in big volleys), so a linear discount would
// barely move the files the discount exists for.
const CHURN_HALF = 0.15;

function stalePenalty(l, churn) {
  if (!churn) return 0.5;
  let hottest = 0;
  for (const ref of l.stale_refs || []) {
    const r = (churn instanceof Map ? churn.get(ref) : churn[ref]) || 0;
    if (r > hottest) hottest = r;
  }
  // No stale_refs (a legacy_unverified row) keeps the full penalty.
  return 0.5 * (1 - hottest / (hottest + CHURN_HALF));
}

// `churn` (optional) is a path -> 0..1 rate from store.churnRates; omitted, the
// stale penalty stays flat at its historical 0.5.
export function scoreLearnings(rows, { terms = [], files = [], now = Date.now(), churn } = {}) {
  const fileSet = new Set(files);
  const dirs = new Set(files.map(subsystemOf));
  return rows
    .map((l) => {
      let relevance = 0;
      for (const ref of l.refs || []) {
        if (fileSet.has(ref)) relevance += 3;
        else if (dirs.has(subsystemOf(ref))) relevance += 1;
      }
      const text = l.text.toLowerCase();
      const refWords = new Set();
      for (const ref of l.refs || []) for (const w of pathTokens(ref)) refWords.add(w);
      for (const t of terms) {
        if (text.includes(t)) relevance += 2;
        else if (refWords.has(t)) relevance += 1;
        else {
          // A query term may itself be a path fragment ("src/sim/jobs/jobBoard.ts",
          // "renderer.ts"); split it the same way refs are and require every part
          // to appear, so precision holds while `learnings <path>` still works.
          const parts = [...pathTokens(t)];
          if (parts.length && parts.every((p) => refWords.has(p))) relevance += 1;
        }
      }

      let score = relevance;
      // Corroboration is weak evidence of durability — a tiebreak, not a driver.
      if (l.corroborations > 1) score += Math.min(1, Math.log2(l.corroborations) / 2);
      // A changed ref is evidence the fact rotted — but only in proportion to
      // how unusual it is for that file to change at all. Without the churn
      // discount, a hotspot every volley touches (groundShader.ts: 31 of the 32
      // facts citing it stale) holds a permanent penalty over everything that
      // cites it, which is noise rather than signal.
      if (l.stale) score -= stalePenalty(l, churn);
      // Recency only breaks ties: fractions of a point across a fortnight.
      const ageDays = (now - Date.parse(l.last_verified_at || 0)) / 86400000;
      if (Number.isFinite(ageDays)) score += Math.max(0, 0.5 - ageDays / 28);
      return { ...l, relevance, score };
    })
    .sort((a, b) => b.score - a.score);
}

// Words too generic to say what a prompt is about. `tokens` already drops the
// short stop words; these are the longer conversational ones.
const PROMPT_STOP = new Set(
  (
    "please could would should there their about what when where which while also just like " +
    "make made want need know think look into then than them they your yours some more most " +
    "only very really still again back done work working thing things stuff okay yeah sure " +
    "right now here thanks lets check change changes changed after before wrong looks better " +
    "nicer issue problem broken next step continue commit push pull merge"
  ).split(" "),
);

// Query terms from free text: normalized tokens, minus conversational filler.
export function queryTerms(text) {
  return [...tokens(text)].filter((w) => w.length > 3 && !PROMPT_STOP.has(w));
}

// Relevance of each checkpoint to a query. A session's checkpoints are only
// worth another session's tokens when they are about the same thing, so this is
// strict: a named file it touched (+3), a query term in its task (+2) or body
// (+1). `matched` counts distinct evidence so callers can demand more than one
// incidental word. Recency is a tiebreak only.
// Crude suffix stemming, applied to both sides, so "lake" meets "lakes" and
// "flicker" meets "flickering". Only for checkpoint matching, where the prose
// is free-form; learnings keep exact tokens.
export function stem(w) {
  const s = w.replace(/(?:ing|ed|es|s)$/, "");
  return s.length >= 4 ? s : w;
}
const stems = (text) => new Set([...tokens(text)].map(stem));

export function scoreCheckpoints(rows, { terms = [], files = [], now = Date.now() } = {}) {
  terms = [...new Set(terms.map(stem))];
  // A prompt usually names a bare file ("hud.js"); checkpoints store repo paths.
  const named = files.map((f) => f.replace(/\\/g, "/"));
  const hits = (f) => named.some((n) => f === n || f.endsWith("/" + n));
  return rows
    .map((c) => {
      let relevance = 0;
      let matched = 0;
      let anchored = 0; // hits in the task line or a named file, not just the body
      for (const f of c.files_touched || []) {
        if (hits(String(f).replace(/\\/g, "/"))) {
          relevance += 3;
          matched++;
          anchored++;
        }
      }
      const task = stems(c.task);
      const body = stems(c.body_md);
      for (const t of terms) {
        if (task.has(t)) {
          relevance += 2;
          matched++;
          anchored++;
        } else if (body.has(t)) {
          relevance += 1;
          matched++;
        }
      }
      const ageDays = (now - Date.parse(c.created_at || 0)) / 86400000;
      const score = relevance + (Number.isFinite(ageDays) ? Math.max(0, 0.5 - ageDays / 28) : 0);
      return { ...c, relevance, matched, anchored, score };
    })
    .sort((a, b) => b.score - a.score);
}

// Stable identity for a checkpoint row (the store has no ids).
export function checkpointKey(c) {
  return `${c.session_id || "?"}@${c.created_at || "?"}`;
}

// Take the best `limit`, but never let one subsystem own the whole budget —
// without this the seed degenerates into "whatever the last commit touched".
export function diversify(scored, limit, perSubsystem = 2) {
  const used = new Map();
  const out = [];
  for (const l of scored) {
    if (out.length >= limit) break;
    const sub = subsystemOf((l.refs || [])[0] || "");
    const n = used.get(sub) || 0;
    if (n >= perSubsystem) continue;
    used.set(sub, n + 1);
    out.push(l);
  }
  // Backfill if the cap starved the list (few subsystems represented).
  if (out.length < limit) {
    for (const l of scored) {
      if (out.length >= limit) break;
      if (!out.includes(l)) out.push(l);
    }
  }
  return out;
}
