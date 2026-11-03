// The overview: who is working on what, for Robin (2026-10-15: "keep an overview of what everyone is working on").
// `buildOverview` gathers it from the live board and the job queue; the Stop hook writes it to
// .claude/cairn/overview.json at the end of every session's turn, so the data is never older than the last turn
// anyone took. `cairn overview --html [file]` fills assets/overview.html with it (written to .claude/cairn/overview.html by default); the commander publishes
// that page as an artifact (a hook can't publish to claude.ai). Hand-written commander notes live in
// .claude/cairn/overview-notes.md and are carried into the page as they are.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ago, liveSessions, recentFilesOf, roleOf, stateOf } from "./activity.mjs";
import { loadOf, readJobs, readNotices, unanswered } from "./jobs.mjs";
import { dataDir } from "./store.mjs";
import { readThreads } from "./threads.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, "..", "assets", "overview.html");
const short = (t, n) => (String(t || "").length > n ? `${String(t).slice(0, n - 1)}…` : String(t || ""));
const jobRow = (j) => ({ id: j.id, title: short(j.title, 220), to: j.to, from: j.from?.name || "", at: j.at });

export function buildOverview(cwd, { nowMs = Date.now() } = {}) {
  const sessions = liveSessions(cwd, { nowMs }).filter((s) => s.peer);
  const jobs = readJobs(cwd);
  const held = (s) => jobs.filter((j) => j.status === "taken" && j.taken_by?.id === s.sessionId);
  return {
    at: new Date(nowMs).toISOString(),
    sessions: sessions.map((s) => ({
      name: s.peer?.name || s.name || s.sessionId.slice(0, 8),
      id: s.sessionId.slice(0, 8),
      role: roleOf(s) || "",
      status: stateOf(s),
      active: s.last_active ? ago(s.last_active, nowMs) : "",
      task: short(s.task, 240),
      state: s.status || "",
      open: (s.open_threads || []).map((t) => short(t, 160)),
      jobs: held(s).map(jobRow),
      files: recentFilesOf(s, 5),
    })),
    waiting: sessions.filter((s) => s.peer?.status === "waiting").map((s) => s.peer?.name || s.sessionId.slice(0, 8)),
    unheld: jobs.filter((j) => j.status === "open").map(jobRow),
    finished: jobs
      .filter((j) => j.done_at && nowMs - Date.parse(j.done_at) <= 6 * 3600000)
      .map((j) => ({ ...jobRow(j), status: j.status, by: j.done_by?.name || "", result: short(j.result, 220), done: j.done_at })),
    threads: (() => {
      const t = readThreads(cwd);
      return { new: t.filter((x) => x.status === "new").length, tracked: t.filter((x) => x.status === "tracked").length };
    })(),
    load: loadOf(cwd, { nowMs, jobs }).flags.map((f) => f.replace(/^- /, "")),
    notices: readNotices(cwd, { nowMs, days: 1 }).slice(-6).map((n) => ({ at: n.at, from: n.from, text: short(n.text, 300) })),
    noReply: unanswered(cwd, { nowMs }).slice(0, 8).map((m) => ({ at: m.at, from: m.from, to: m.to, line: m.line })),
    notes: (() => {
      const p = join(dataDir(cwd), "overview-notes.md");
      return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
    })(),
  };
}

export function writeOverview(cwd, opts) {
  const data = buildOverview(cwd, opts);
  writeFileSync(join(dataDir(cwd), "overview.json"), JSON.stringify(data, null, 1));
  return data;
}

// The page: the template with the data embedded (`<` escaped so no text can close the script tag).
export function renderOverviewHtml(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return readFileSync(TEMPLATE, "utf8").replace("/*OVERVIEW_DATA*/null", json);
}
