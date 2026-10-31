// PostToolUse (matcher Edit|Write|MultiEdit|NotebookEdit): record the edited
// file on this session's live-board entry, and if another live session edited
// the same file recently, tell the agent once — its uncommitted work is in that
// file (docs/CAIRN.md §live activity). A plan file (plan mode, under
// <config dir>/plans/) records the repo paths it names as this session's planned
// files instead, and says which other live sessions already hold any of them.
//
// Advisory only: it runs after the edit, never blocks one, and warns once per
// (file, other session) pair so a long edit run on a shared file stays quiet.

import { readFileSync } from "node:fs";
import {
  EDIT_TOOLS,
  ago,
  isPlanFile,
  otherEditors,
  otherPlanners,
  repoPath,
  samePath,
  liveSessions,
  touch,
  who,
} from "../lib/activity.mjs";
import { areaOf, readAreas } from "../lib/areas.mjs";
import { logMessage, me, noticeNews } from "../lib/jobs.mjs";
import { idFor, nameFor, peers } from "../lib/peers.mjs";
import { envelope, renderLearning } from "../lib/context.mjs";
import { hookMain } from "../lib/hook.mjs";
import { queryTerms, scoreLearnings } from "../lib/rank.mjs";
import { churnRates, log, readState, recallable, writeState } from "../lib/store.mjs";

const AREA_LEARNINGS = 3;
// A same-folder ref alone scores 1 (client/ui/hud.js facts for a shop.js edit); 2 needs a named
// file, the area's words in the text, or two ref hits.
const AREA_MIN_RELEVANCE = 2;

// First edit this session makes in a docs/AREAS.md area: name the area's doc (or
// say it has none yet) and add that area's top learnings, so "pull before you
// push" and "update the doc in the same change" arrive without being asked for.
// Once per area per session; edits to docs themselves don't trigger it.
function areaNudge(cwd, file, state) {
  if (file.startsWith("docs/") || file.endsWith(".md")) return null;
  const area = areaOf(readAreas(cwd), file);
  if (!area || (state.areas_seen || []).includes(area.name)) return null;
  state.areas_seen = [...(state.areas_seen || []), area.name];

  const lines = [`First edit in area "${area.name}" (docs/AREAS.md).`];
  if (area.docs.length) {
    lines.push(`Its doc: ${area.docs.join(", ")}. If this change alters what it describes, update it in the same change.`);
  } else if (area.undocumented) {
    lines.push(
      "It has no doc yet (docs/README.md \"Not yet written up\"). If you change its design, write " +
        "docs/design/<topic>.md, add an index row, and link it in its docs/AREAS.md row.",
    );
  }
  const terms = [...queryTerms(area.name), ...area.patterns.map((p) => p.pattern)];
  const learned = scoreLearnings(recallable(cwd), { terms, files: [file], churn: churnRates(cwd) })
    .filter((l) => l.relevance >= AREA_MIN_RELEVANCE)
    .slice(0, AREA_LEARNINGS);
  if (learned.length) lines.push("Learnings for this area:", ...learned.map(renderLearning));
  lines.push("`pnpm docs-check` checks the docs rules before you finish.");
  log(cwd, `area: ${area.name} (${file})`);
  return envelope("area", lines.join("\n"));
}

// A plan was written: record what it names, then say once per plan write which
// other live sessions edited or plan any of those paths, so the split gets
// agreed before the edits start rather than discovered after.
function planWritten(cwd, sessionId, path, input) {
  let text = input.content;
  if (typeof text !== "string") {
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }
  const next = touch(cwd, sessionId, { plan: { file: path, text } });
  const mine = Object.keys(next?.activity?.planned || {});
  if (!mine.length) return null;
  const clashes = [];
  for (const s of liveSessions(cwd, { exclude: sessionId })) {
    const edited = Object.keys(s.files || {}).filter((f) => mine.some((p) => samePath(p, f)));
    const planned = Object.keys(s.planned || {}).filter((f) => mine.some((p) => samePath(p, f)));
    if (edited.length || planned.length)
      clashes.push(
        `- [${who(s)}] ${s.task || "(task not yet known)"}` +
          (edited.length ? `\n  edited: ${edited.slice(0, 6).join(", ")}` : "") +
          (planned.length ? `\n  plans to edit: ${planned.slice(0, 6).join(", ")}` : ""),
      );
  }
  log(cwd, `plan: ${mine.length} path(s), ${clashes.length} other session(s) overlap`);
  if (!clashes.length) return null;
  return envelope(
    "plan-overlap",
    `Your plan names ${mine.length} repo path(s). Other live sessions already hold some of them:\n` +
      `${clashes.join("\n")}\n` +
      "Agree the split with them before editing those files: message each by name (SendMessage; ListAgents lists the names).",
  );
}

// A message to another session: log it (lib/jobs.mjs) so the report can show the
// traffic and what is still waiting for a reply. Messages between a session and
// its own subagents ("main", agent ids) stay out of it.
function messageSent(cwd, sessionId, input) {
  const reg = peers(cwd);
  const to = nameFor(reg, input.to);
  if (!to || to === "main" || /^a[0-9a-f]{12,}$/i.test(to)) return;
  logMessage(cwd, {
    dir: "sent",
    from: me(cwd, sessionId)?.name || sessionId.slice(0, 8),
    to,
    text: input.message,
    fromId: sessionId,
    toId: idFor(reg, input.to),
  });
}

hookMain("post_tool_use", (payload, cwd) => {
  if (payload.tool_name === "SendMessage") {
    messageSent(cwd, payload.session_id || "unknown", payload.tool_input || {});
    return null;
  }
  if (!EDIT_TOOLS.has(payload.tool_name)) return null;
  const input = payload.tool_input || {};
  const raw = input.file_path || input.notebook_path || input.path;
  const sessionId = payload.session_id || "unknown";

  if (isPlanFile(raw)) {
    const note = planWritten(cwd, sessionId, raw, input);
    return note
      ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } }
      : null;
  }

  const file = repoPath(cwd, raw);
  if (!file || file.startsWith(".claude/cairn/")) return null;

  touch(cwd, sessionId, { file });

  const state = readState(cwd, sessionId);
  const parts = [];
  const nudge = areaNudge(cwd, file, state);
  if (nudge) parts.push(nudge);

  const others = otherEditors(cwd, file, { exclude: sessionId });
  const planners = otherPlanners(cwd, file, { exclude: sessionId }).filter(
    (p) => !others.some((o) => o.sessionId === p.sessionId),
  );
  const warned = new Set(state.overlap_warned || []);
  const fresh = others.filter((o) => !warned.has(`${file}|${o.sessionId}`));
  const freshPlans = planners.filter((o) => !warned.has(`${file}|${o.sessionId}`));
  if (fresh.length || freshPlans.length) {
    state.overlap_warned = [
      ...warned,
      ...[...fresh, ...freshPlans].map((o) => `${file}|${o.sessionId}`),
    ].slice(-200);
    const lines = [
      ...fresh.map((o) => `- [${who(o)}] edited it ${ago(o.editedAt)}: ${o.task || "(task not yet known)"}`),
      ...freshPlans.map((o) => `- [${who(o)}] plans to edit it (${o.plannedAs}): ${o.task || "(task not yet known)"}`),
    ];
    log(cwd, `overlap: ${file} (${[...fresh, ...freshPlans].map((o) => who(o)).join(", ")})`);
    parts.push(
      envelope(
        "overlap",
        `Another live session is also working on ${file}:\n${lines.join("\n")}\n` +
          (fresh.length
            ? "Its uncommitted changes are in this file. Re-read it before further edits, keep your " +
              "changes to your own task, and don't revert or rewrite what it added. "
            : "") +
          "If the split isn't agreed yet, message that session by name (SendMessage; ListAgents lists the names).",
      ),
    );
  }
  // A busy session may go a long while without a prompt; its edits still bring it the notice board.
  try {
    const board = noticeNews(cwd, sessionId, state);
    if (board) parts.push(envelope("notices", board));
  } catch (err) {
    log(cwd, `notices: ${err?.message || err}`);
  }
  if (!parts.length) return null;
  writeState(cwd, sessionId, state);
  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: parts.join("\n") },
  };
});
