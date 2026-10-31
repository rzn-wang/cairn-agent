// Jobs and messages between sessions (docs/CAIRN.md §jobs and messages).
//
// Jobs: one session asks another (by name or by role) to do something, and the
// request is kept until it is done or declined, so it survives a busy recipient,
// a compaction or a restart. jobs.jsonl is append-only: a job row, then control
// rows (take, done, decline, note) folded in on read, like learnings.
//
//   job:  { kind: "job", id, at, from: { id, name }, to, title, detail, files }
//   ctl:  { ctl: "take"|"done"|"decline"|"note", id, at, by: { id, name }, note }
//
// Messages: SendMessage is the transport; Cairn only logs what was sent and
// received (messages.jsonl) so the report can show the traffic and the messages
// still waiting for a reply. Cairn never sends: the messaging socket is Claude
// Code's internal interface.
//
//   msg:  { at, dir: "sent"|"received", from, to, line }   (names, first line only)

import { liveSessions, roleOf, who } from "./activity.mjs";
import { peers } from "./peers.mjs";
import { appendRow, now, readRows, rewriteRows } from "./store.mjs";

const JOBS = "jobs.jsonl";
const MSGS = "messages.jsonl";
const MSG_KEEP = 1000;
export const NO_REPLY_MS = 15 * 60000;

// This session, from Claude Code's environment (CLAUDE_CODE_SESSION_ID) or --as.
export function me(cwd, as) {
  const id = as || process.env.CLAUDE_CODE_SESSION_ID || null;
  if (!id) return null;
  const s = liveSessions(cwd, {}).find((x) => x.sessionId === id);
  return { id, name: peers(cwd).get(id)?.name || s?.name || id.slice(0, 8), role: s ? roleOf(s) : null };
}

export function readJobs(cwd) {
  const jobs = new Map();
  for (const r of readRows(cwd, JOBS)) {
    if (r.kind === "job") jobs.set(r.id, { ...r, status: "open", log: [] });
    else if (r.ctl && jobs.has(r.id)) {
      const j = jobs.get(r.id);
      j.log.push(r);
      if (r.ctl === "take") (j.status = "taken"), (j.taken_by = r.by);
      if (r.ctl === "done") (j.status = "done"), (j.done_at = r.at), (j.done_by = r.by), (j.result = r.note);
      if (r.ctl === "decline") (j.status = "declined"), (j.done_at = r.at), (j.done_by = r.by), (j.result = r.note);
      if (r.ctl === "release") (j.status = "open"), (j.taken_by = undefined), (j.released = r.note); // handed back, unfinished
      if (["take", "note", "release"].includes(r.ctl)) j.touched_at = r.at;
    }
  }
  // Names as they are now: Claude Code renames sessions and reuses names, so a job taken by "calerion-chronicles-55"
  // on 10-15 (the tuning session) read as the systems session's on 10-19. The id is the truth; a session that has
  // closed keeps its old name, marked so.
  const reg = peers(cwd);
  const now = (by) =>
    by?.id && String(by.id).length > 8 ? { ...by, name: reg.get(by.id)?.name || `${by.name} (closed)` } : by;
  return [...jobs.values()].map((j) => ({ ...j, from: now(j.from), taken_by: now(j.taken_by), done_by: now(j.done_by) }));
}

export function addJob(cwd, { from, to, title, detail = "", files = [] }) {
  const ids = readRows(cwd, JOBS).filter((r) => r.kind === "job").map((r) => r.id);
  const job = { kind: "job", id: ids.length ? Math.max(...ids) + 1 : 1, at: now(), from, to, title, detail, files };
  appendRow(cwd, JOBS, job);
  return job;
}

export function updateJob(cwd, id, ctl, by, note = "") {
  const job = readJobs(cwd).find((j) => j.id === Number(id));
  if (!job) return null;
  appendRow(cwd, JOBS, { ctl, id: job.id, at: now(), by, note });
  return readJobs(cwd).find((j) => j.id === job.id);
}

// Is `job` addressed to this session? By its name, its role (either way round:
// "water" reaches "water and sea"), or "anyone".
// Matched on whole words, so "art" never reaches "character modeler".
const wordSet = (t) => new Set(String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
export function addressedTo(job, { name, role }) {
  const to = String(job.to || "").toLowerCase().trim();
  if (!to || to === "anyone" || to === "all") return true;
  if (name && to === name.toLowerCase()) return true;
  if (!role) return false;
  const a = wordSet(to);
  const b = wordSet(role);
  const within = (x, y) => x.size > 0 && [...x].every((w) => y.has(w));
  return within(a, b) || within(b, a);
}

// The open session a job addressed to `to` would reach first, or null.
export function recipientFor(cwd, to) {
  const t = String(to || "").toLowerCase();
  const reg = peers(cwd);
  for (const s of liveSessions(cwd, {}).filter((x) => x.peer)) {
    const name = reg.get(s.sessionId)?.name || s.name;
    if (addressedTo({ to: t }, { name, role: roleOf(s) })) return { s, name, role: roleOf(s) };
  }
  return null;
}

export function jobsFor(cwd, session, { open = true } = {}) {
  return readJobs(cwd).filter(
    (j) =>
      (!open || j.status === "open" || (j.status === "taken" && j.taken_by?.id === session.id)) &&
      (j.taken_by ? j.taken_by.id === session.id : addressedTo(j, session)) &&
      j.from?.id !== session.id,
  );
}

export function renderJob(j, nowMs = Date.now()) {
  const age = Math.max(1, Math.round((nowMs - Date.parse(j.at)) / 60000));
  const state =
    j.status === "taken" ? `taken by ${j.taken_by?.name}` : j.status === "open" ? "open" : `${j.status} by ${j.done_by?.name}`;
  return (
    `#${j.id} ${j.title} — from ${j.from?.name} to ${j.to || "anyone"}, ${state}, ${age < 60 ? `${age} min` : `${Math.round(age / 60)} h`} ago` +
    (j.files?.length ? `\n  files: ${j.files.join(", ")}` : "") +
    (j.detail ? `\n  ${j.detail}` : "") +
    (j.result ? `\n  result: ${j.result}` : "")
  );
}

// --- notices ----------------------------------------------------------------
// The notice board: one post every open session sees once, instead of the same
// message sent to each (seco-12 sent five, the commander nine, on 2026-10-06).
//   notice: { id, at, from: { id, name }, to: "all"|role|name, text }
const NOTICES = "notices.jsonl";
export const NOTICE_MAX = 600; // longer belongs in a doc, with the notice linking to it
const NOTICE_DAYS = 2;

export function addNotice(cwd, { from, to = "all", text }) {
  const ids = readRows(cwd, NOTICES).map((r) => r.id).filter(Number.isFinite);
  const row = { id: ids.length ? Math.max(...ids) + 1 : 1, at: now(), from, to, text: String(text).trim() };
  appendRow(cwd, NOTICES, row);
  return row;
}

export function readNotices(cwd, { nowMs = Date.now(), days = NOTICE_DAYS } = {}) {
  return readRows(cwd, NOTICES).filter((n) => nowMs - Date.parse(n.at) <= days * 86400000);
}

// Notices for this session that it hasn't been shown: not its own, addressed to all or to it.
export function noticesFor(cwd, session, seen = []) {
  const shown = new Set(seen);
  return readNotices(cwd).filter(
    (n) => n.from?.id !== session.id && !shown.has(n.id) && addressedTo({ to: n.to }, session),
  );
}

export function renderNotice(n, nowMs = Date.now()) {
  const min = Math.max(1, Math.round((nowMs - Date.parse(n.at)) / 60000));
  return `- #${n.id} ${n.from?.name}${n.to && n.to !== "all" ? ` → ${n.to}` : ""}, ${min < 60 ? `${min} min` : `${Math.round(min / 60)} h`} ago: ${n.text}`;
}

// New notices for this session, rendered once (its state's `notices_seen` is updated in place).
export function noticeNews(cwd, sessionId, state, { max = 6 } = {}) {
  const self = me(cwd, sessionId);
  if (!self) return null;
  const fresh = noticesFor(cwd, self, state.notices_seen || []);
  if (!fresh.length) return null;
  state.notices_seen = [...(state.notices_seen || []), ...fresh.map((n) => n.id)].slice(-300);
  return (
    `Notice board (posts for every session; information, not Robin's orders):\n` +
    fresh.slice(-max).map((n) => renderNotice(n)).join("\n") +
    (fresh.length > max ? `\n(${fresh.length - max} older: node scripts/cairn/cairn.mjs notices)` : "")
  );
}

// --- stale jobs -------------------------------------------------------------
// A taken job with no update for STALE_MS, or an open job nobody took for OPEN_STALE_MS. Sessions get redirected (by
// Robin, or by another job) and leave a job "taken" with nothing happening: it looks owned, so nobody picks it up.
export const STALE_MS = 3 * 3600000;
export const OPEN_STALE_MS = 6 * 3600000;

export function staleJobs(cwd, { nowMs = Date.now() } = {}) {
  return readJobs(cwd).filter((j) =>
    j.status === "taken"
      ? nowMs - Date.parse(j.touched_at || j.at) > STALE_MS
      : j.status === "open" && nowMs - Date.parse(j.touched_at || j.at) > OPEN_STALE_MS,
  );
}

// --- messages ---------------------------------------------------------------
// A message that only reports needs no answer: "No reply needed", FYI, or a "done"/"committed" report on its first
// line (58 of the "no reply yet" list on 2026-10-07 were reports like these, not unanswered questions).
const NEEDS_NO_REPLY =
  /\bno reply (is )?needed\b|\bno need to reply\b|\bfyi\b|^[^\n]{0,80}\b(done|finished|committed|landed|is in|added it myself|thanks)\b/i;

// Only a message that asks something waits for a reply: a question, or a request. Status lines ("starting X"),
// answers ("yes, add it yourself") and heads-ups don't, and were most of the list before this.
const ASKS = /\?|\b(please|could you|can you|would you|will you|let me know|tell me|ok to|okay to)\b/i;

// `text` is the whole message: only its first line is kept, plus whether it says
// no reply is needed (those never show as waiting for one).
export function logMessage(cwd, { dir, from, to, text, fromId = null, toId = null }) {
  const body = String(text || "");
  appendRow(cwd, MSGS, {
    at: now(),
    dir,
    from,
    to,
    ...(fromId ? { from_id: fromId } : {}),
    ...(toId ? { to_id: toId } : {}),
    line: body.split("\n").find((l) => l.trim())?.trim().slice(0, 200) || "",
    no_reply: NEEDS_NO_REPLY.test(body),
    asks: ASKS.test(body),
  });
  const rows = readRows(cwd, MSGS);
  if (rows.length > MSG_KEEP * 1.2) rewriteRows(cwd, MSGS, rows.slice(-MSG_KEEP));
}

export function readMessages(cwd, { withinMs = 6 * 3600000, nowMs = Date.now() } = {}) {
  return readRows(cwd, MSGS).filter((m) => nowMs - Date.parse(m.at) <= withinMs);
}

// Messages older than NO_REPLY_MS whose recipient has not written back to the sender since.
// Sent and received rows of one message are both logged (one by each side); pair on names.
export function unanswered(cwd, { nowMs = Date.now() } = {}) {
  const msgs = readMessages(cwd, { nowMs });
  // A party is its session id when the row has one, else its name: a renamed session's reply still counts.
  const party = (m, side) => String(m[`${side}_id`] || m[side]).toLowerCase();
  const key = (a, b) => `${a}→${b}`;
  const last = new Map();
  for (const m of msgs) {
    const k = key(party(m, "from"), party(m, "to"));
    last.set(k, Math.max(last.get(k) || 0, Date.parse(m.at)));
  }
  const seen = new Set();
  const out = [];
  for (const m of [...msgs].reverse()) {
    const k = key(party(m, "from"), party(m, "to"));
    if (seen.has(k)) continue;
    seen.add(k);
    const sent = Date.parse(m.at);
    const reply = last.get(key(party(m, "to"), party(m, "from"))) || 0;
    const asks = m.asks ?? ASKS.test(m.line || ""); // rows logged before `asks` was recorded: judge the first line
    if (asks && !m.no_reply && !NEEDS_NO_REPLY.test(m.line || "") && reply < sent && nowMs - sent > NO_REPLY_MS)
      out.push(m);
  }
  return out;
}

// Jobs held per open session, and a flag when one holds LOAD or more while an idle open session of the same role
// holds none (Robin, 2026-10-15: the Kickoff session held 8 jobs while the second world-generator session sat idle).
export const LOAD = 4;
export function loadOf(cwd, { nowMs = Date.now(), jobs = readJobs(cwd) } = {}) {
  const open = liveSessions(cwd, { nowMs }).filter((s) => s.peer);
  const held = new Map(open.map((s) => [s.sessionId, []]));
  for (const j of jobs) if (j.status === "taken" && held.has(j.taken_by?.id)) held.get(j.taken_by.id).push(j.id);
  const n = (s) => held.get(s.sessionId).length;
  const rows = open
    .filter((s) => n(s))
    .sort((a, b) => n(b) - n(a))
    .map((s) => `- ${who(s)}: ${n(s)} (#${held.get(s.sessionId).join(", #")})`);
  const flags = [];
  for (const s of open) {
    const role = roleOf(s);
    if (n(s) < LOAD || !role) continue;
    const spare = open.filter((o) => o !== s && roleOf(o) === role && !n(o) && o.peer.status === "idle");
    if (spare.length)
      flags.push(
        `- ${who(s)} holds ${n(s)} jobs while ${spare.map(who).join(", ")} (${role}, idle) holds none: ` +
          'hand some over (docs/WORKING.md, "Jobs")',
      );
  }
  return { rows, flags };
}

// The report's section: open jobs by recipient, recently finished ones, traffic, unanswered.
export function renderQueue(cwd, { nowMs = Date.now() } = {}) {
  const jobs = readJobs(cwd);
  const open = jobs.filter((j) => j.status === "open" || j.status === "taken");
  const recent = jobs.filter((j) => j.done_at && nowMs - Date.parse(j.done_at) <= 6 * 3600000);
  const out = [open.length ? `## Jobs open (${open.length})` : "## Jobs open: none", ...open.map((j) => `- ${renderJob(j, nowMs)}`)];
  const load = loadOf(cwd, { nowMs, jobs });
  if (load.rows.length) out.push(`## Jobs held (${load.rows.length} session(s))`, ...load.rows);
  if (load.flags.length) out.push(`## Load: hand work over (${load.flags.length})`, ...load.flags);
  const stale = staleJobs(cwd, { nowMs });
  if (stale.length)
    out.push(
      `## Going stale (${stale.length}): taken with no update for ${STALE_MS / 3600000} h, or open for ${OPEN_STALE_MS / 3600000} h`,
      ...stale.map(
        (j) => `- #${j.id} ${j.title.slice(0, 90)} (${j.status === "taken" ? `held by ${j.taken_by?.name}` : `for ${j.to}, nobody took it`})`,
      ),
    );
  if (recent.length) out.push(`## Jobs finished in the last 6 h (${recent.length})`, ...recent.map((j) => `- ${renderJob(j, nowMs)}`));
  const board = readNotices(cwd, { nowMs, days: 1 });
  if (board.length) out.push(`## Notice board, last 24 h (${board.length})`, ...board.slice(-10).map((n) => renderNotice(n, nowMs)));
  const msgs = readMessages(cwd, { nowMs, withinMs: 2 * 3600000 });
  const sent = msgs.filter((m) => m.dir === "sent");
  if (sent.length) {
    out.push(`## Messages in the last 2 h (${sent.length} sent)`);
    for (const m of sent.slice(-12)) out.push(`- ${m.at.slice(11, 16)} ${m.from} → ${m.to}: ${m.line}`);
  }
  const waiting = unanswered(cwd, { nowMs });
  if (waiting.length) {
    out.push(`## No reply yet (older than ${NO_REPLY_MS / 60000} min)`);
    for (const m of waiting.slice(0, 8)) out.push(`- ${m.at.slice(11, 16)} ${m.from} → ${m.to}: ${m.line}`);
  }
  return out.join("\n");
}

export { who };
