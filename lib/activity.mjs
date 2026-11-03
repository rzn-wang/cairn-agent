// Live session activity: which sessions are working right now, on what, in which
// files (docs/CAIRN.md §live activity). Several agents share one working tree
// here, so the question a session most needs answered is not "what did the last
// session conclude" but "who else is in these files at the moment".
//
// Each session records its own activity in its state file (state/<id>.json,
// field `activity`), written only by that session's hooks — so there is no
// cross-session write race. Readers scan every state file.
//
//   activity: { started_at, last_active, task, task_source, status, open_threads, name,
//               files: { "<repo-relative path>": "<iso of last edit>" },
//               plan: { file, at }, planned: { "<repo-relative path>": "<iso>" } }
//
// `files` is what a session edited; `planned` is what its latest plan file says it
// will edit. They stay separate: an edit overlap is uncommitted work at risk, a
// plan overlap is a heads-up.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { configDir, label, peers, plansDir } from "./peers.mjs";
import { now, readAllStates, readState, repoRoot, writeState } from "./store.mjs";

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const LIVE_MS = 6 * 3600000; // a session idle longer than this is not "live"
export const OVERLAP_MS = 3600000; // an edit older than this no longer warns (was 3 h: most warnings were stale)
const MAX_FILES = 60;
const MAX_PLANNED = 40;
const MIN_TASK_PROMPT = 15; // "go for it" is not a task description

// Repo-relative, forward-slash path, or null for anything outside the repo
// (plan files, scratchpads) — those are never shared territory.
export function repoPath(cwd, p) {
  if (!p) return null;
  const root = repoRoot(cwd);
  const rel = isAbsolute(p) ? relative(root, p) : p;
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

// A plan file written under <config dir>/plans/ (plan mode), or null.
export function isPlanFile(p) {
  if (!p) return false;
  const rel = relative(plansDir(), p);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel) && /\.md$/i.test(rel);
}

function clip(text, n = 90) {
  const clean = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= n ? clean : clean.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

// Blocks the harness wraps around a prompt (the IDE's open file, a background
// task finishing, reminders) are not what the person asked for.
const HARNESS_BLOCK =
  /<(ide_opened_file|ide_selection|system-reminder|task-notification|command-[\w-]+|local-command-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g;
const HARNESS_TASK = /^(The user opened the file|The user selected|This session is being continued)/;

// Prompts no person typed: another session's message, a subagent hand-back, a
// background task finishing. Recall on these was ~70% of all injections and
// almost never relevant (review, 2026-10-06).
const MACHINE_PROMPT =
  /^\s*(<task-notification\b|<agent-message\b|<cross-session-message\b|\[Cross-session delivery|<system-reminder\b|\[SYSTEM NOTIFICATION|\[Cross-session|\[Subagent hand-back|Another Claude session sent a message|This session is being continued)/;

// What the person actually wrote, with the harness's wrapper blocks removed; null
// when the prompt came from a machine rather than a person.
export function humanText(prompt) {
  const raw = String(prompt || "");
  if (MACHINE_PROMPT.test(raw)) return null;
  const text = raw.replace(HARNESS_BLOCK, "\n").trim();
  return MACHINE_PROMPT.test(text) || !text ? null : text;
}

// The role a person gave a session in plain words: "ur the world generator",
// "hi, you're the lore manager" → "world generator", "lore manager". Null otherwise.
// "ur" is also "your" ("what is ur cutoff date"), so after it the article is required.
const ROLE_RE =
  /(?:^|[\s,.!])(?:(?:ur|u r)\s+(?:the|our|my)|(?:you'?re|you are)(?:\s+(?:the|our|my))?)\s+([a-z][\w -]{2,40}?)(?:\s*(?:[.,!?;:]|\band\b|\bnow\b|$))/i;
export function promptRole(prompt) {
  const text = humanText(prompt);
  if (!text) return null;
  const m = ROLE_RE.exec(text.split("\n").find((l) => l.trim()) || "");
  if (!m) return null;
  const role = m[1].trim().toLowerCase();
  return /^(here|right|done|welcome|not|so|going|doing|working|a |an )/.test(role) ? null : role;
}

export function promptTask(prompt) {
  const text = humanText(prompt);
  if (!text) return null;
  const first = clip(text.split("\n").find((l) => l.trim() && !/^\s*</.test(l)) || "");
  return first.length >= MIN_TASK_PROMPT && !HARNESS_TASK.test(first) ? first : null;
}

// Repo paths a plan names as its own work. With a "Files" heading, only that
// section counts; sub-lists labelled reuse / don't edit / by request / off
// limits are skipped, since plans also name files they promise not to touch.
// A bare `name.ts` after a path on the same line resolves into that path's folder.
// Any path whose first folder exists at the repo root (checked in planPaths).
const PATH_RE = /(?:^|[\s`(\[,*])([\w.-]+\/[\w.\-\/*]*)/g;
const BARE_RE = /`([\w.\-]+\.[a-z]{1,5})`/g;
// Only as a list label ("- **Reuse:**", "- Off limits (…):"), so a claim that merely says "reuse" stays mine.
// The keyword must sit in the label, before the first colon or backticked path.
const NOT_MINE =
  /^\s*(?:[-*]|\d+\.)?\s*[^:`]{0,60}?\b(reuse|don'?t (edit|touch)|by request|off limits|read[- ]only|not mine|untouched)\b/i;

export function planPaths(cwd, text) {
  let lines = String(text || "").split("\n");
  const head = lines.findIndex((l) => /^#{1,4}\s.*\bfiles\b/i.test(l));
  if (head >= 0) {
    const level = /^#+/.exec(lines[head])[0].length;
    const end = lines.findIndex((l, i) => i > head && new RegExp(`^#{1,${level}}\\s`).test(l));
    lines = lines.slice(head + 1, end < 0 ? undefined : end);
  }
  const root = repoRoot(cwd);
  const out = new Set();
  let skipIndent = -1;
  let dir = null; // carried onto a wrapped continuation line, reset by each new bullet
  for (const line of lines) {
    const indent = /^\s*/.exec(line)[0].length;
    if (skipIndent >= 0 && (indent > skipIndent || !line.trim())) continue;
    skipIndent = -1;
    if (NOT_MINE.test(line)) {
      skipIndent = indent;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(line) || !line.trim()) dir = null;
    const found = [];
    for (const m of line.matchAll(PATH_RE)) found.push([m.index, m[1]]);
    for (const m of line.matchAll(BARE_RE)) if (!m[1].includes("/")) found.push([m.index, null, m[1]]);
    found.sort((a, b) => a[0] - b[0]);
    for (const [, path, bare] of found) {
      let p = path;
      if (!p && bare && dir) p = dir + bare;
      if (!p) continue;
      p = p.replace(/[.,:;)]+$/, "");
      if (p.includes("*")) p = p.slice(0, p.indexOf("*")).replace(/[^/]*$/, ""); // a glob → its folder
      if (!/\.[a-z]\w*$/i.test(p) && !p.endsWith("/")) continue; // a file or folder, not "d/0.5"
      // New files and folders are fine, but the path must start at the repo root ("sea/shader.ts" is
      // shorthand, not a path), and a folder claim needs three levels: a plan that mentions "src/render/"
      // or "tools/" in passing must not claim half the repo (it did, 2026-10-06).
      if (!existsSync(join(root, p.split("/")[0]))) continue;
      if (p.endsWith("/") && p.split("/").filter(Boolean).length < 3) continue;
      dir = p.endsWith("/") ? p : p.replace(/[^/]*$/, "");
      out.add(p);
    }
  }
  return [...out].slice(0, MAX_PLANNED);
}

// Update this session's activity. `prompt` names the task until a checkpoint
// supplies a distilled one; `file` records an edit; `plan` ({ file, text }) replaces
// the planned paths; `checkpoint` (a checkpoint row) replaces task/status/open
// threads with the distilled versions.
export function touch(cwd, sessionId, { prompt, file, plan, checkpoint, role } = {}) {
  if (!sessionId || sessionId === "unknown" || sessionId === "manual") return null;
  const state = readState(cwd, sessionId);
  const a = { files: {}, ...(state.activity || {}) };
  const at = now();
  a.started_at ||= at;
  a.last_active = at;
  if (a.task && a.task_source === "prompt" && HARNESS_TASK.test(a.task)) delete a.task;
  if (role) a.role = role; // `cairn role`, which always wins
  else if (prompt && !a.role) {
    const r = promptRole(prompt);
    if (r) a.role = r;
  }
  if (prompt && a.task_source !== "checkpoint" && !a.task) {
    const task = promptTask(prompt);
    if (task) {
      a.task = task;
      a.task_source = "prompt";
    }
  }
  if (file) {
    a.files[file] = at;
    const keys = Object.keys(a.files);
    if (keys.length > MAX_FILES) {
      keys.sort((x, y) => (a.files[x] < a.files[y] ? -1 : 1));
      for (const k of keys.slice(0, keys.length - MAX_FILES)) delete a.files[k];
    }
  }
  if (plan) {
    a.plan = { file: basename(plan.file), at };
    a.planned = Object.fromEntries(planPaths(cwd, plan.text).map((p) => [p, at]));
  }
  if (checkpoint) {
    a.task = clip(checkpoint.task, 120);
    a.task_source = "checkpoint";
    a.status = checkpoint.status;
    a.open_threads = (checkpoint.open_threads || []).slice(0, 3).map((t) => clip(t, 120));
  }
  // Keep the registry name, so a session that has closed is still known by it.
  const name = peers(cwd).get(sessionId)?.name;
  if (name) a.name = name;
  const next = { ...state, activity: a };
  writeState(cwd, sessionId, next);
  return next;
}

// Other sessions active within `withinMs`, most recent first. `peer` is the
// registry entry (name, status) when Claude Code has one for the session.
export function liveSessions(cwd, { exclude, withinMs = LIVE_MS, nowMs = Date.now(), peerMap } = {}) {
  const reg = peerMap || peers(cwd);
  return readAllStates(cwd)
    // A session Claude Code still has open counts however long it has been idle: a message wakes it, so
    // it can still take a job (sessions idle 8 h were dropped from routing, 2026-10-07). Closed ones count
    // only within `withinMs`, for the edits they left behind.
    .filter(({ sessionId, state }) => {
      const last = Date.parse(state.activity?.last_active || 0);
      return sessionId !== exclude && (reg.has(sessionId) || nowMs - last <= withinMs);
    })
    .map(({ sessionId, state }) => {
      const a = { ...state.activity };
      if (a.task_source === "prompt" && HARNESS_TASK.test(a.task || "")) delete a.task; // recorded before the filter
      // Plans recorded before the folder rule may hold "src/render/" or "props/": drop those on read.
      if (a.planned)
        a.planned = Object.fromEntries(
          Object.entries(a.planned).filter(([p]) => !p.endsWith("/") || p.split("/").filter(Boolean).length >= 3),
        );
      return { sessionId, ...a, peer: reg.get(sessionId) || null };
    })
    .sort((a, b) => (a.last_active < b.last_active ? 1 : -1));
}

// Sessions other than `exclude` that edited `file` within `withinMs`.
export function otherEditors(cwd, file, { exclude, withinMs = OVERLAP_MS, nowMs = Date.now() } = {}) {
  return liveSessions(cwd, { exclude, withinMs, nowMs })
    .filter((s) => s.files?.[file] && nowMs - Date.parse(s.files[file]) <= withinMs)
    .map((s) => ({ ...s, editedAt: s.files[file] }));
}

// A path and a planned path collide when equal, or when one is a folder ("src/x/") holding the other.
export function samePath(a, b) {
  return a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));
}

// Live sessions other than `exclude` whose latest plan names `file` (or its folder).
export function otherPlanners(cwd, file, { exclude, nowMs = Date.now() } = {}) {
  return liveSessions(cwd, { exclude, nowMs })
    .map((s) => ({ ...s, plannedAs: Object.keys(s.planned || {}).find((p) => samePath(p, file)) }))
    .filter((s) => s.plannedAs);
}

export function ago(iso, nowMs = Date.now()) {
  const ms = nowMs - Date.parse(iso);
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min ago`;
  const h = ms / 3600000;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function shortId(sessionId) {
  return String(sessionId || "").slice(0, 8);
}

// "seco-70 · 0543bd72" for a live-session row (registry name, else the cached one).
export function who(s) {
  return label(s.sessionId, null, s.peer?.name || s.name);
}

// A session's role: the one recorded in its state, else the first role given in
// the opening prompts of its transcript (sessions introduced before roles were
// recorded). Reads at most the first 256 KB, once per process.
const roleCache = new Map();
export function roleOf(s) {
  if (s.role) return s.role.split(/[:,;(]/)[0].trim(); // roles set as a sentence before the trim
  if (roleCache.has(s.sessionId)) return roleCache.get(s.sessionId);
  let role = null;
  try {
    const projects = join(configDir(), "projects");
    for (const d of readdirSync(projects)) {
      const p = join(projects, d, `${s.sessionId}.jsonl`);
      if (!existsSync(p)) continue;
      const fd = openSync(p, "r");
      const buf = Buffer.alloc(Math.min(statSync(p).size, 256 * 1024));
      try {
        readSync(fd, buf, 0, buf.length, 0);
      } finally {
        closeSync(fd);
      }
      let seen = 0;
      for (const line of buf.toString("utf8").split("\n")) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (row.type !== "user" || row.isMeta || row.isSidechain) continue;
        const c = row.message?.content;
        // The IDE's open-file note arrives as its own text block before the person's words.
        const text =
          typeof c === "string"
            ? c
            : (Array.isArray(c) ? c : []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
        if (!text || !humanText(text)) continue;
        role = promptRole(text);
        if (role || ++seen >= 5) break;
      }
      break;
    }
  } catch {
    /* no transcript: no role */
  }
  roleCache.set(s.sessionId, role);
  return role;
}

// Registry status ("busy", "waiting", "idle"), or "closed" once the process is gone.
export function stateOf(s) {
  return s.peer ? s.peer.status || "open" : "closed";
}

// Files most recently edited by a session, newest first.
export function recentFilesOf(activity, n = 6) {
  return Object.entries(activity?.files || {})
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, n)
    .map(([f]) => f);
}

// The seed's "who is working on what" block. Empty string when nobody else is live.
export function renderLiveBoard(cwd, { exclude, nowMs = Date.now(), max = 8, files: nFiles = 6 } = {}) {
  // Open sessions first; a closed one stays listed only while it left edits behind.
  const all = liveSessions(cwd, { exclude, nowMs });
  const live = [
    ...all.filter((s) => s.peer),
    ...all.filter((s) => !s.peer && Object.keys(s.files || {}).length),
  ];
  if (!live.length) return "";
  const lines = [
    `Other sessions active in the last ${LIVE_MS / 3600000} h (they share this working tree — ` +
      "their uncommitted changes are in these files; don't overwrite or revert them). " +
      "Names are what SendMessage takes:",
  ];
  for (const s of live.slice(0, max)) {
    const files = recentFilesOf(s, nFiles);
    const more = Object.keys(s.files || {}).length - files.length;
    const planned = Object.keys(s.planned || {});
    const status = s.status ? `, ${s.status}` : "";
    lines.push(
      `- [${who(s)}]${roleOf(s) ? ` (${roleOf(s)})` : ""} ${stateOf(s)}, ${ago(s.last_active, nowMs)}${status}: ${s.task || "(task not yet known)"}` +
        (files.length ? `\n  files: ${files.join(", ")}${more > 0 ? ` (+${more} more)` : ""}` : "") +
        (planned.length
          ? `\n  plans to edit: ${planned.slice(0, nFiles).join(", ")}${planned.length > nFiles ? ` (+${planned.length - nFiles} more)` : ""}`
          : "") +
        (s.open_threads?.length ? `\n  open: ${s.open_threads.join("; ")}` : ""),
    );
  }
  if (live.length > max) lines.push(`(+${live.length - max} more live sessions)`);
  return lines.join("\n");
}
