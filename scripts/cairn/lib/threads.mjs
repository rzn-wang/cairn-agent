// Open threads: every loose end a session leaves goes to the systems agent (Robin, 2026-10-19; docs/WORKING.md
// section 7). Cairn captures them by itself, from two places: each checkpoint's `open_threads` (lib/lifecycle.mjs)
// and the "Open" / "Still open" list at the end of a session's reply (the Stop hook). The systems session sees the new
// ones on its next prompt and sorts each: tracked (a row in docs/design/threads.md), done, or dropped.
//
// threads.jsonl holds thread rows and control rows folded on read, like jobs:
//   thread: { kind: "thread", id, at, text, session, name, role, source }
//   ctl:    { ctl: "track"|"done"|"drop"|"reopen"|"seen", id, at, by, note }

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./peers.mjs";
import { sameFact, tokens } from "./rank.mjs";
import { appendRow, now, readCheckpoints, readRows, repoRoot } from "./store.mjs";

const FILE = "threads.jsonl";
const NOTHING = /^(?:nothing|none|no(?:thing)? (?:open|left)|n\/a|-)\.?$/i;

export function readThreads(cwd) {
  const threads = new Map();
  for (const r of readRows(cwd, FILE)) {
    if (r.kind === "thread") threads.set(r.id, { ...r, status: "new", notes: [], mentions: 1 });
    else if (r.ctl && threads.has(r.id)) {
      const t = threads.get(r.id);
      if (r.ctl === "seen") t.mentions++, (t.last = r.at);
      else if (r.ctl === "reopen") (t.status = "new"), t.notes.push(r.note);
      else (t.status = { track: "tracked", done: "done", drop: "dropped" }[r.ctl] || t.status), r.note && t.notes.push(r.note);
      if (r.ctl !== "seen") (t.by = r.by), (t.changed = r.at);
    }
  }
  return [...threads.values()];
}

// Adds each text as a thread unless it restates one already held (then it counts as seen again, and a thread that
// was closed before this mention opens again). Returns the rows added.
export function addThreads(cwd, texts, { session = "unknown", name = "", role = "", source = "reply", at = now() } = {}) {
  const held = readThreads(cwd).map((t) => ({ t, tok: tokens(t.text) }));
  let next = held.reduce((m, { t }) => Math.max(m, t.id), 0) + 1;
  const added = [];
  for (const item of texts || []) {
    const it = typeof item === "string" ? { text: item } : item;
    const when = it.at || at;
    const text = String(it.text || "").replace(/\s+/g, " ").replace(/^["'`]|["'`]$/g, "").trim().slice(0, 400);
    if (text.length < 8 || NOTHING.test(text)) continue;
    const tok = tokens(text);
    const same = held.find((h) => sameFact(h.tok, tok));
    if (same) {
      const t = same.t;
      const closedBefore = (t.status === "done" || t.status === "dropped") && (t.changed || "") < when;
      if (closedBefore) (t.status = "new"), (t.changed = when);
      appendRow(
        cwd,
        FILE,
        closedBefore
          ? { ctl: "reopen", id: t.id, at: when, by: name, note: `raised again by ${name || it.session || session}` }
          : { ctl: "seen", id: t.id, at: when, by: name },
      );
      continue;
    }
    const row = {
      kind: "thread",
      id: next++,
      at: when,
      text,
      session: String(it.session || session).slice(0, 8),
      name,
      role,
      source: it.source || source,
    };
    appendRow(cwd, FILE, row);
    held.push({ t: { ...row, status: "new" }, tok });
    added.push(row);
  }
  return added;
}

export function setThread(cwd, id, ctl, by, note = "") {
  const t = readThreads(cwd).find((x) => x.id === Number(id));
  if (!t) return null;
  appendRow(cwd, FILE, { ctl, id: t.id, at: now(), by, note });
  return readThreads(cwd).find((x) => x.id === t.id);
}

// The items of an "Open" list at the end of a reply: a heading or bold label ("## Open", "**Still open**",
// "**Open:**", "Left open:", "What's left") followed by bullets, or the label's own text on the same line.
const LABEL =
  /^(?:#{1,4}\s*)?(?:\*\*)?\s*(?:still open|open threads?|open items?|left open|open|what'?s left(?: open)?|still to do|remaining|loose ends)\s*(?:\*\*)?\s*(:)?\s*(?:\*\*)?\s*(.*)$/i;
export function openItems(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LABEL.exec(lines[i].trim());
    const rest = m ? m[2].replace(/\*\*/g, "").trim() : "";
    if (!m || (!m[1] && rest)) continue; // "Open the panel" is a sentence, not a label
    if (rest && !NOTHING.test(rest)) out.push(rest);
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l) {
        if (out.length && /^\s*([-*]|\d+\.)\s/.test(lines[j + 1] || "")) continue;
        if (j > i + 1) break;
        continue;
      }
      const b = /^([-*]|\d+\.)\s+(.*)$/.exec(l);
      if (!b) break;
      out.push(b[2].replace(/\*\*/g, "").trim());
      i = j;
    }
  }
  return out.filter((t) => t && !NOTHING.test(t));
}

// The session transcripts of this repo: Claude Code keeps them under <config>/projects/<repo path as a slug>.
function transcriptDir(cwd) {
  const slug = repoRoot(cwd).replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  const base = join(configDir(), "projects");
  if (!existsSync(base)) return null;
  const hit = readdirSync(base).find((d) => d.toLowerCase() === slug);
  return hit ? join(base, hit) : null;
}

// Each turn's last text in a transcript, with its time: what the session ended that turn with.
function turnEndings(path) {
  const out = [];
  let turn = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || r.isSidechain) continue;
    if (r.type === "user" && !r.isMeta) {
      const c = r.message?.content;
      const txt = typeof c === "string" ? c : (c || []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
      if (txt.trim()) {
        if (turn?.last) out.push(turn);
        turn = { last: null, at: r.timestamp };
      }
      continue;
    }
    if (r.type === "assistant" && turn)
      for (const b of r.message?.content || []) if (b.type === "text" && b.text.trim()) (turn.last = b.text), (turn.at = r.timestamp || turn.at);
  }
  if (turn?.last) out.push(turn);
  return out;
}

// Backfill: every checkpoint's open threads and every turn's "Open" list since `since`, oldest first, then close
// the ones that name a job already done or declined. Returns counts.
export function backfill(cwd, { since = "2026-10-13", jobs = [] } = {}) {
  const items = [];
  for (const c of readCheckpoints(cwd))
    if ((c.created_at || "") >= since)
      for (const t of c.open_threads || []) items.push({ at: c.created_at, text: t, session: c.session_id, source: "backfill:checkpoint" });
  const dir = transcriptDir(cwd);
  if (dir)
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      const session = f.slice(0, 8);
      for (const t of turnEndings(join(dir, f)))
        if ((t.at || "") >= since) for (const text of openItems(t.last)) items.push({ at: t.at, text, session, source: "backfill:reply" });
    }
  items.sort((a, b) => (a.at < b.at ? -1 : 1));
  const added = addThreads(cwd, items).length;
  const done = new Map(jobs.filter((j) => j.status === "done" || j.status === "declined").map((j) => [j.id, j]));
  let closed = 0;
  for (const t of readThreads(cwd).filter((x) => x.status === "new")) {
    const ids = [...t.text.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1]));
    if (ids.length && ids.every((id) => done.has(id))) {
      setThread(cwd, t.id, "done", "cairn", `job${ids.length > 1 ? "s" : ""} ${ids.map((i) => "#" + i).join(", ")} finished`);
      closed++;
    }
  }
  return { found: items.length, added, closed, open: readThreads(cwd).filter((t) => t.status === "new").length };
}
