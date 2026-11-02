// `cairn report`: everything the live board knows, in one read, for a person or a
// coordinating session: who is open and in what state, who is waiting on a human,
// and which paths two or more sessions hold (edited or planned). Reads state files
// and Claude Code's session registry only, never transcripts (some run to 150 MB).

import { OVERLAP_MS, ago, liveSessions, recentFilesOf, roleOf, samePath, stateOf, who } from "./activity.mjs";
import { basename } from "node:path";
import { stem } from "./rank.mjs";
import { repoRoot } from "./store.mjs";
import { person } from "./config.mjs";
import { fileProximity } from "./graph/recall.mjs";

const WHO_STOP = new Set(
  "the and for with this that from into what who which can you need needs make made want wants does doing work works working on of to in a an is are be it simtest playtest build test tests check checks fix fixed pnpm node cairn job done".split(" "), // in every task, so they say nothing about who owns what
);
const words = (t) =>
  new Set(
    String(t || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !WHO_STOP.has(w))
      .map(stem),
  );
// Claude Code's derived session name is the repo folder as a slug plus a short id ("calerion-chronicles-e9"): it
// says nothing about the work, so it never matches a word.
const slug = (cwd) => basename(repoRoot(cwd)).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const generic = (name, cwd) => !name || String(name).toLowerCase().startsWith(`${slug(cwd)}-`);

// `cairn who <words or paths>`: which open session is the right one for a job.
// Paths match the files a session edited or plans to edit (same file, then same
// folder); words match its name, its role and its task. Returns ranked rows.
export function whoFor(cwd, query, { nowMs = Date.now() } = {}) {
  const q = String(query || "");
  const paths = q.split(/\s+/).filter((w) => w.includes("/") || /\.[a-z]\w*$/i.test(w));
  const terms = words(q.replace(/\S*[/.]\S*/g, " "));
  const rows = [];
  // The knowledge graph: files close to what the job names (imports, co-change, tests), so a session working
  // next door is found even when no path or word matches. Null without a graph.
  const near = fileProximity(cwd, { text: q, files: paths, terms: [...words(q)] });
  for (const s of liveSessions(cwd, { nowMs }).filter((x) => x.peer)) {
    const why = [];
    let score = 0;
    const edited = Object.keys(s.files || {});
    const held = [...edited, ...Object.keys(s.planned || {})];
    if (near?.size) {
      let prox = 0;
      let best = null;
      for (const f of edited) {
        const a = near.get(f) || 0;
        prox += a;
        if (!best || a > best[1]) best = [f, a];
      }
      for (const f of Object.keys(s.planned || {})) prox += 0.6 * (near.get(f) || 0);
      const add = Math.round(4 * Math.min(1, prox / 0.5));
      if (add > 0 && !paths.some((p) => edited.some((h) => samePath(h, p) || h.endsWith("/" + p)))) {
        score += add;
        if (best?.[1] > 0) why.push(`works on ${best[0]}, close to it in the code graph`);
      }
    }
    const hit = (list, p) => list.some((h) => samePath(h, p) || h.endsWith("/" + p));
    for (const p of paths) {
      const dir = p.includes("/") ? p.replace(/[^/]*$/, "") : null;
      const mine = edited.filter((h) => samePath(h, p) || h.endsWith("/" + p));
      if (mine.length) {
        const at = Math.max(...mine.map((h) => Date.parse(s.files[h])));
        const recent = nowMs - at <= OVERLAP_MS;
        score += recent ? 6 : 2;
        why.push(`edited ${p} ${ago(new Date(at).toISOString(), nowMs)}`);
      } else if (hit(held, p)) {
        score += 4;
        why.push(`plans to edit ${p}`);
      } else if (dir && dir.split("/").length > 2 && held.some((h) => h.startsWith(dir))) {
        score += 3;
        why.push(`works in ${dir}`);
      }
    }
    const name = s.peer?.name || s.name;
    const role = roleOf(s);
    const named = new Set([...(generic(name, cwd) ? [] : words(name)), ...words(role)]);
    const tasked = words(`${s.task || ""} ${(s.open_threads || []).join(" ")}`);
    for (const t of terms) {
      if (named.has(t)) {
        score += 3;
        why.push(`"${t}" in its name or role`);
      } else if (tasked.has(t)) {
        score += 1;
        why.push(`"${t}" in its task`);
      }
    }
    if (score) rows.push({ s, score, why, role, name });
  }
  return rows.sort((a, b) => b.score - a.score || (a.s.last_active < b.s.last_active ? 1 : -1));
}

export function renderWho(cwd, query) {
  const rows = whoFor(cwd, query).slice(0, 5);
  if (!rows.length)
    return `No open session matches "${query}". Do it yourself, or ask ${person()} which session should (docs/WORKING.md section 2).`;
  return [
    `Open sessions for "${query}", best first (send to the name before the ·):`,
    ...rows.map(
      ({ s, why, role }) =>
        `- ${who(s)} — ${stateOf(s)}${role ? `, role: ${role}` : ""}; ${s.task || "(task not yet known)"}\n  because: ${why.join(", ")}`,
    ),
  ].join("\n");
}

export function renderReport(cwd, { nowMs = Date.now(), files = 8 } = {}) {
  const all = liveSessions(cwd, { nowMs });
  const open = all.filter((s) => s.peer);
  const closed = all.filter((s) => !s.peer && Object.keys(s.files || {}).length);
  const out = [];

  const waiting = open.filter((s) => s.peer.status === "waiting");
  out.push(
    `${open.length} open session(s) in this repo` +
      (waiting.length ? `; waiting on a human: ${waiting.map(who).join(", ")}` : "") +
      (closed.length ? `; ${closed.length} closed in the last 6 h left edits` : ""),
    "",
  );

  for (const s of [...open, ...closed]) {
    const edited = Object.keys(s.files || {});
    const planned = Object.keys(s.planned || {});
    const role = roleOf(s);
    out.push(`## ${who(s)} — ${stateOf(s)}, active ${ago(s.last_active, nowMs)}${role ? `; role: ${role}` : ""}`);
    out.push(`task: ${s.task || "(not yet known)"}${s.status ? ` (${s.status})` : ""}`);
    if (s.open_threads?.length) out.push(`open: ${s.open_threads.join("; ")}`);
    if (edited.length)
      out.push(
        `edited (${edited.length}): ${recentFilesOf(s, files).join(", ")}${edited.length > files ? ", …" : ""}`,
      );
    if (planned.length)
      out.push(
        `plan ${s.plan?.file || ""} names (${planned.length}): ${planned.slice(0, files).join(", ")}` +
          (planned.length > files ? ", …" : ""),
      );
    out.push("");
  }

  // Collisions: a path (or a folder holding it) claimed by two or more sessions.
  // Edits count for 3 h, like the overlap warning; a plan counts while its session is live.
  const claims = [];
  for (const s of [...open, ...closed]) {
    for (const [f, at] of Object.entries(s.files || {}))
      if (nowMs - Date.parse(at) <= OVERLAP_MS) claims.push({ path: f, s, how: `edited ${ago(at, nowMs)}`, at });
    for (const [f, at] of Object.entries(s.planned || {})) claims.push({ path: f, s, how: "plans", at });
  }
  claims.sort((a, b) => (a.at < b.at ? 1 : -1));
  const seen = new Set();
  const rows = [];
  for (const c of claims) {
    if (seen.has(c.path)) continue;
    const holders = claims.filter((d) => samePath(d.path, c.path));
    const sessions = new Map(); // newest claim per session first, since claims are sorted
    for (const h of holders) {
      const prev = sessions.get(h.s.sessionId);
      if (!prev) sessions.set(h.s.sessionId, { s: h.s, how: h.how });
      else if (prev.how === "plans" && h.how !== "plans") prev.how = `${h.how}, plans`;
      else if (prev.how !== "plans" && h.how === "plans") prev.how = `${prev.how}, plans`;
    }
    if (sessions.size < 2) continue;
    for (const h of holders) seen.add(h.path);
    rows.push(
      `- ${c.path}: ${[...sessions.values()].map(({ s, how }) => `${who(s)} (${how})`).join(", ")}`,
    );
  }
  out.push(rows.length ? `## Shared paths (${rows.length})` : "## Shared paths: none");
  out.push(...rows);
  return out.join("\n");
}
