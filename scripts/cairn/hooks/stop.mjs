// Stop: decide whether the segment since the last checkpoint deserves one; if
// so, drop the in-flight marker and spawn the distiller DETACHED so the turn
// finishes instantly (only PreCompact distills synchronously).
//
// One exception to "never continues the conversation" (Robin, 2026-10-07): a
// turn that ends with questions for Robin written in prose, without the
// AskUserQuestion tool, is sent back once to ask them in the tool (lib/ask.mjs).
// Only once per stop (stop_hook_active), so it can't loop, and never for a turn
// that already asked. The old Review gate (an AskUserQuestion "done or still
// working?" after every substantial turn) stays retired: this fires only when the
// reply itself asks something. CAIRN_ASK=0 turns it off.

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { touch } from "../lib/activity.mjs";
import { lastTurn, questionsLeftInProse } from "../lib/ask.mjs";
import { addThreads, openItems } from "../lib/threads.mjs";
import { writeOverview } from "../lib/overview.mjs";
import { hookMain } from "../lib/hook.mjs";
import { segmentSince, shouldDistill } from "../lib/lifecycle.mjs";
import { inflightAgeMs, log, readState, setInflight } from "../lib/store.mjs";
import { stats } from "../lib/transcript.mjs";

hookMain("stop", (payload, cwd) => {
  try {
    touch(cwd, payload.session_id); // still live on the board
  } catch {
    /* advisory */
  }
  try {
    // The reply's "Open" list goes to the systems agent (lib/threads.mjs; Robin, 2026-10-19).
    const { texts } = lastTurn(payload.transcript_path);
    const items = openItems(texts[texts.length - 1]);
    if (items.length) {
      const a = readState(cwd, payload.session_id || "unknown").activity || {};
      addThreads(cwd, items, { session: payload.session_id, name: a.name || "", role: a.role || "", source: "reply" });
    }
  } catch (err) {
    log(cwd, `threads: ${err?.message || err}`);
  }
  try {
    writeOverview(cwd); // who is working on what, current as of this turn (lib/overview.mjs)
  } catch (err) {
    log(cwd, `overview: ${err?.message || err}`);
  }

  if (!payload.stop_hook_active && process.env.CAIRN_ASK !== "0") {
    try {
      const found = questionsLeftInProse(payload.transcript_path);
      if (found) {
        const { decisions, leave, waits = [] } = found;
        const quote = (qs) => qs.slice(0, 3).map((q) => `"${q.slice(0, 80)}"`).join("; ");
        const parts = [];
        if (leave.length)
          parts.push(
            `You asked Robin for leave to carry on (${quote(leave)}). Don't: when your objectives are clear (your ` +
              "task, your jobs, the milestone), pick the order yourself and keep working (docs/WORKING.md section 1). " +
              "Do that now if there is work left; if everything is truly done, end with your finishing message and no question. " +
              "The one exception: Robin said to approve this stage before the next (a stage of a phase plan, a look to sign " +
              "off). Then it is a decision: ask it with the AskUserQuestion tool.",
          );
        if (decisions.length)
          parts.push(
            `Your reply ends with ${decisions.length === 1 ? "a question" : "questions"} for Robin in the text ` +
              `(${quote(decisions)}). If ${decisions.length === 1 ? "it is a real decision" : "they are real decisions"} ` +
              "(it changes the game, needs Robin's eye, removes something, or goes against a decision), ask with the " +
              "AskUserQuestion tool now: up to 4 per call, 2 to 4 plain options, your recommendation first marked " +
              "(Recommended). If not, decide it yourself and carry on. Don't repeat your summary.",
          );
        if (waits.length && !decisions.length)
          parts.push(
            `Your reply hands Robin a decision or says you are waiting on him (${quote(waits)}). Robin wants that asked, not stated (2026-10-15): ask it now with the AskUserQuestion tool (up to 4 per call, 2 to 4 plain options, your recommendation first marked (Recommended)). If nothing actually needs his answer, don't say you are waiting on him: carry on, or end with your finishing message. Don't repeat your summary.`,
          );
        log(cwd, `stop [${String(payload.session_id).slice(0, 8)}]: sent back (${decisions.length} decision question(s), ${leave.length} asking leave, ${waits.length} waiting)`);
        return { decision: "block", reason: parts.join(" ") + " (Cairn, not Robin.)" };
      }
    } catch (err) {
      log(cwd, `stop [${String(payload.session_id).slice(0, 8)}]: ask check failed: ${err?.message || err}`);
    }
  }

  const { events } = segmentSince(cwd, payload.session_id, payload.transcript_path);
  if (!shouldDistill(events)) {
    // Logged so "there are no checkpoints" is always diagnosable: this line
    // distinguishes "the hook declined" from "the hook never ran".
    const { assistantTurns, edits } = stats(events);
    log(cwd, `stop [${String(payload.session_id).slice(0, 8)}]: no distill (turns ${assistantTurns}, edits ${edits})`);
    return null;
  }

  // A distill already in flight for THIS session owns its segment — the segment
  // marker only advances inside the child, so a second spawn would checkpoint it
  // twice. A distill takes up to ~30 s, so the guard lasts 90 s (it was 15 s, and
  // shared by every session).
  const age = inflightAgeMs(cwd, payload.session_id);
  if (age !== null && age < 90000) {
    log(cwd, "stop: distill already in flight, skipping");
    return null;
  }

  setInflight(cwd, payload.session_id);
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cairn.mjs");
  spawn(
    process.execPath,
    [
      cli,
      "checkpoint",
      "--session",
      payload.session_id || "unknown",
      "--transcript",
      payload.transcript_path || "",
      "--trigger",
      "stop",
    ],
    { cwd, detached: true, stdio: "ignore", windowsHide: true },
  ).unref();

  return { systemMessage: "cairn: checkpoint queued" };
});
