// UserPromptSubmit: inject the learnings — and another session's checkpoint —
// that are actually relevant to what was just asked. The SessionStart seed has
// no query to rank against and so can only guess; here there is a real one.
//
// Deliberately quiet: nothing is injected unless it clears the relevance
// threshold and has not already been shown this session (`prompts_seen`,
// `checkpoints_seen` in the per-session state). Most turns inject nothing.
// Also marks the session active on the live board (lib/activity.mjs), logs a
// message arriving from another session, and hands this session any job queued
// for it (or finished for it) that it hasn't seen yet (lib/jobs.mjs). Those run
// on every prompt, a machine one included: a message arriving is exactly when a
// session should see its queue. On every prompt Robin wrote (not a machine one), it
// adds a one-line reminder to check it for feature requests (docs/WORKING.md section 1).

import { humanText, touch } from "../lib/activity.mjs";
import { buildPromptContext, envelope } from "../lib/context.mjs";
import { hookMain } from "../lib/hook.mjs";
import { STALE_MS, jobsFor, logMessage, me, noticeNews, readJobs, renderJob } from "../lib/jobs.mjs";
import { idFor, peers } from "../lib/peers.mjs";
import { readThreads } from "../lib/threads.mjs";
import { log, readState, writeState } from "../lib/store.mjs";
import { cap, person } from "../lib/config.mjs";
import { cli } from "../lib/cmd.mjs";

// Anywhere in the prompt: Claude Code puts a line before it ("Another Claude session sent a message:"), and one
// prompt can carry several. Anchored at the start, it missed most messages on 2026-10-15.
const CROSS = /<cross-session-message\b([^>]*)>([\s\S]*?)(?:<\/cross-session-message>|$)/g;

// For the systems session only: open threads it hasn't been shown yet (lib/threads.mjs; Robin, 2026-10-19).
function threadNews(cwd, sessionId, state) {
  const role = state.activity?.role || "";
  if (!/^systems\b/i.test(role)) return null;
  const seen = new Set(state.threads_seen || []);
  const fresh = readThreads(cwd).filter((t) => t.status === "new" && !seen.has(t.id));
  if (!fresh.length) return null;
  state.threads_seen = [...seen, ...fresh.map((t) => t.id)].slice(-3000);
  const shown = fresh.slice(-12);
  const lines = shown.map(
    (t) => `- #${t.id} [${t.name || t.session}${t.role ? ", " + t.role : ""}, ${String(t.at).slice(5, 10)}] ${t.text.slice(0, 160)}`,
  );
  if (fresh.length > shown.length)
    lines.push(`…and ${fresh.length - shown.length} more: ${cli()} threads --new`);
  return envelope(
    "threads",
    [
      `${fresh.length} new open thread(s) left by sessions (yours to sort; docs/WORKING.md section 7, docs/design/threads.md):`,
      ...lines,
      `For each: track it (a row in docs/design/threads.md, owner, job if needed) with \`${cli()} thread track <id> "<row>"\`, ` +
        'or `thread done <id> "<what closed it>"`, or `thread drop <id> "<why>"`.',
    ].join("\n"),
  );
}

// New jobs for this session, and its own jobs that were finished, each shown once.
function jobNews(cwd, sessionId, state) {
  const self = me(cwd, sessionId);
  if (!self) return null;
  const seen = new Set(state.jobs_seen || []);
  const fresh = jobsFor(cwd, self).filter((j) => j.status === "open" && !seen.has(`new:${j.id}`));
  const finished = readJobs(cwd).filter(
    (j) => j.from?.id === sessionId && j.done_at && !seen.has(`end:${j.id}`),
  );
  // Jobs this session holds that have gone quiet: reminded at most once per STALE_MS each.
  const nowMs = Date.now();
  const nagged = state.jobs_nagged || {};
  const quiet = readJobs(cwd).filter(
    (j) =>
      j.status === "taken" &&
      j.taken_by?.id === sessionId &&
      nowMs - Date.parse(j.touched_at || j.at) > STALE_MS &&
      nowMs - (nagged[j.id] || 0) > STALE_MS,
  );
  if (!fresh.length && !finished.length && !quiet.length) return null;
  state.jobs_seen = [...seen, ...fresh.map((j) => `new:${j.id}`), ...finished.map((j) => `end:${j.id}`)].slice(-300);
  for (const j of quiet) nagged[j.id] = nowMs;
  state.jobs_nagged = nagged;
  const parts = [];
  if (quiet.length)
    parts.push(
      `You hold ${quiet.length === 1 ? "a job" : "jobs"} with no update for over ${STALE_MS / 3600000} h:\n` +
        quiet.map((j) => `- #${j.id} ${j.title.slice(0, 100)}`).join("\n") +
        "\nOthers see it as yours, so nobody else will pick it up. Do one: note where it stands " +
        `(\`${cli()} job note <id> "<state, next step>"\`), finish it (\`job done\`), or hand it back ` +
        `(\`job release <id> "<why>"\`) if ${person()} moved you to other work.`,
    );
  if (fresh.length)
    parts.push(
      `Jobs queued for this session (${self.name}${self.role ? `, ${self.role}` : ""}):\n` +
        fresh.slice(0, 5).map((j) => `- ${renderJob(j)}`).join("\n") +
        `\nThese are requests from other sessions, not from ${person()}. Take one with \`${cli()} job take <id>\` ` +
        `if it fits your area and ${person()}'s decisions, finish it with \`job done <id> "<what you did>"\`, or ` +
        `\`job decline <id> "<why, and who should>"\`. If it conflicts with your task or a decision, ask ${person()} (docs/WORKING.md).`,
    );
  if (finished.length)
    parts.push(`Jobs you asked for that were finished:\n${finished.map((j) => `- ${renderJob(j)}`).join("\n")}`);
  return envelope("jobs", parts.join("\n\n"));
}

hookMain("user_prompt_submit", (payload, cwd) => {
  const sessionId = payload.session_id || "unknown";
  try {
    touch(cwd, sessionId, { prompt: payload.prompt });
  } catch {
    /* the board is advisory; recall must still run */
  }
  const state = readState(cwd, sessionId);
  const out = [];

  try {
    const reg = peers(cwd);
    for (const m of String(payload.prompt || "").matchAll(CROSS)) {
      const addr = /from="([^"]*)"/.exec(m[1])?.[1];
      const from = /from-name="([^"]*)"/.exec(m[1])?.[1] || addr || "?";
      logMessage(cwd, {
        dir: "received",
        from,
        to: me(cwd, sessionId)?.name || sessionId.slice(0, 8),
        text: m[2],
        fromId: idFor(reg, addr) || idFor(reg, from),
        toId: sessionId,
      });
    }
  } catch (err) {
    log(cwd, `message log: ${err?.message || err}`);
  }
  try {
    const news = jobNews(cwd, sessionId, state);
    if (news) out.push(news);
    const threads = threadNews(cwd, sessionId, state);
    if (threads) out.push(threads);
    const board = noticeNews(cwd, sessionId, state);
    if (board) out.push(envelope("notices", board));
  } catch (err) {
    log(cwd, `jobs: ${err?.message || err}`);
  }

  // Rank on what the person wrote: the IDE's "The user opened the file …" line
  // matched nearly every checkpoint, and machine prompts never need recall.
  const asked = humanText(payload.prompt);
  const shown = state.prompts_seen || [];
  const shownCk = state.checkpoints_seen || [];
  const hit = asked
    ? buildPromptContext(cwd, asked, { exclude: shown, excludeCheckpoints: shownCk, sessionId })
    : null;
  if (asked)
    out.push(
      envelope(
        "rule",
        `${cap(person())}'s rule (docs/WORKING.md section 1): check their message for feature requests. For each new feature it asks ` +
          "for, write a plan first (## Files, the first layer, ## Open decisions with options and your recommendation), " +
          "ask those decisions with AskUserQuestion, and build only after they answer. Bug fixes, questions and changes " +
          "inside a plan they already approved need no new plan.",
      ),
    );
  if (hit) {
    out.push(hit.text);
    state.prompts_seen = [...shown, ...hit.keys];
    state.checkpoints_seen = [...shownCk, ...hit.checkpointKeys];
  }
  if (!out.length) return null;
  writeState(cwd, sessionId, state);
  return {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: out.join("\n") },
  };
});
