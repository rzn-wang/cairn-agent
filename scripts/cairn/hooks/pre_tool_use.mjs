// PreToolUse (matcher Edit|Write|MultiEdit|NotebookEdit): before this session's
// first edit of a file another OPEN session edited in the last hour, hold the
// edit once and say who holds the file, so the split gets agreed before the
// edit rather than discovered after (docs/WORKING.md section 3). The warning
// used to come only after the edit, and changed the agent's next step about 3
// times in 13 (review, 2026-10-06).
//
// Once per (file, other session), shared with the PostToolUse warning, so a
// repeated edit goes straight through. Only ever "deny" or nothing: "allow"
// would skip the person's own permission prompts. Sessions that have closed
// don't hold edits (nobody to talk to); PostToolUse still notes their work.

import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { EDIT_TOOLS, ago, otherEditors, repoPath, who } from "../lib/activity.mjs";
import { hookMain } from "../lib/hook.mjs";
import { isPermissionQuestion } from "../lib/ask.mjs";
import { MIN_FREE_GB, classify, limit, unquoted, waitForSlot } from "../lib/heavy.mjs";
import { readMessages } from "../lib/jobs.mjs";
import { nameFor, peers } from "../lib/peers.mjs";
import { log, readState, repoRoot, writeState } from "../lib/store.mjs";

const HOLD_MS = 3600000; // an edit older than an hour no longer holds anyone up

// Message rules (docs/WORKING.md section 3), held once each so a resend goes
// through: a long message (its content belongs in a doc, the message links to
// it), the same first line to a third session within 15 minutes (that's the
// notice board), and a bare thank-you (it wakes a busy session for nothing).
const LONG_MESSAGE = 1200;
const ACK = /^\s*(thanks|thank you|thx|ty|noted|got it|ok|okay|great|cool|perfect|agreed|sounds good|will do)\b[\s\S]{0,60}$/i;

function messageRule(cwd, sessionId, input) {
  const to = nameFor(peers(cwd), input.to);
  if (!to || to === "main" || /^a[0-9a-f]{12,}$/i.test(to)) return null;
  const text = String(input.message || "");
  const first = text.split("\n").find((l) => l.trim())?.trim() || "";
  const state = readState(cwd, sessionId);
  const key = `msg|${first.slice(0, 80)}|${text.length}`;
  if ((state.message_held || []).includes(key)) return null;
  let reason = null;
  if (text.length > LONG_MESSAGE)
    reason =
      `This message is ${text.length} characters. Content that long (a spec, a list, a plan) belongs in a doc or file ` +
      "that other sessions can find later; write it there and send a short message that links to it. If it really " +
      "has to be a message, send it again unchanged and it will go through.";
  else if (ACK.test(text) && !/\?/.test(text))
    reason =
      "This looks like a thank-you or acknowledgement. It wakes a busy session for nothing: skip it unless they asked " +
      "for confirmation. If it carries something they need, send it again and it will go through.";
  else {
    const me = (state.activity && state.activity.name) || null;
    const recent = readMessages(cwd, { withinMs: 15 * 60000 }).filter(
      (m) => m.dir === "sent" && (m.from === me || !me) && m.line.slice(0, 50) === first.slice(0, 50) && m.to !== to,
    );
    if (first.length >= 20 && new Set(recent.map((m) => m.to)).size >= 2)
      reason =
        "You've sent this same message to other sessions in the last 15 minutes. For news every session should " +
        'see, post one notice instead: node scripts/cairn/cairn.mjs notice "<text>" (each open session sees it once). ' +
        "If this one is really for this session alone, send it again and it will go through.";
  }
  if (!reason) return null;
  state.message_held = [...(state.message_held || []), key].slice(-100);
  writeState(cwd, sessionId, state);
  log(cwd, `hold message: ${reason.slice(0, 40)}… (to ${to})`);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Cairn held this message once (not Robin): ${reason} (docs/WORKING.md section 3)`,
    },
  };
}

// A question box that only asks leave to carry on ("Should I go ahead?", "What next?") is held
// once: with clear objectives the session picks the order itself (docs/WORKING.md section 1).
function leaveOnlyAsk(cwd, sessionId, input) {
  const qs = (input.questions || []).map((q) => String(q.question || ""));
  if (!qs.length || !qs.every(isPermissionQuestion)) return null;
  const state = readState(cwd, sessionId);
  const key = `ask|${qs.join("|").slice(0, 160)}`;
  if ((state.message_held || []).includes(key)) return null;
  state.message_held = [...(state.message_held || []), key].slice(-100);
  writeState(cwd, sessionId, state);
  log(cwd, `hold ask: leave to carry on (${qs[0].slice(0, 60)})`);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Cairn held this question once (not Robin): it only asks leave to carry on. When your objectives are clear " +
        "(your task, your jobs, the milestone), pick the order yourself and keep working; ask Robin only for real " +
        "decisions (docs/WORKING.md section 1). If Robin said to approve this stage before the next, it is a decision: " +
        "ask again unchanged and it will go through.",
    },
  };
}

// The checks belong to the tuning agent (Robin, 2026-10-15; docs/WORKING.md "Checks and tuning"): a session with
// another role editing a gate file or the sweep is held once per file, so a retune goes to the tuning agent as a job,
// while a feature's own new check still goes through when the edit is repeated (Robin chose hold-once over refusal).
// Matched on the path's tail, so a worker's copy in a worktree outside the repo is held too.
const CHECK_FILE = /(?:^|[\\/])(?:src[\\/]sim[\\/]engine[\\/]gate[^\\/]*\.ts|tools[\\/]worldgen-sweep\.mjs)$/;
function tuningRule(cwd, sessionId, input) {
  const raw = String(input.file_path || input.notebook_path || input.path || "");
  if (!CHECK_FILE.test(raw)) return null;
  const state = readState(cwd, sessionId);
  if (/^tuning\b/i.test(state.activity?.role || "")) return null;
  const tail = raw.replace(/\\/g, "/").match(/(?:src\/sim\/engine\/gate[^/]*\.ts|tools\/worldgen-sweep\.mjs)$/)[0];
  const key = `tune|${tail}`;
  if ((state.message_held || []).includes(key)) return null;
  state.message_held = [...(state.message_held || []), key].slice(-100);
  writeState(cwd, sessionId, state);
  log(cwd, `hold tuning: ${tail} (${sessionId.slice(0, 8)})`);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Cairn held this edit once (not Robin): ${tail} is a check, and checks are the tuning agent's (Robin, ` +
        '2026-10-15; docs/WORKING.md "Checks and tuning"). If you are changing a bar, a threshold, an exemption or a ' +
        "statistical rule so a check passes, don't: land your change with the miss named in the commit and file " +
        '`node scripts/cairn/cairn.mjs job add "<rule>: <seeds, margin, suspected cause>" --to tuning`. If this edit ' +
        "adds a new check for your own feature, or fixes a bug in how a check reads the world, make it again and it " +
        "will go through.",
    },
  };
}

// A heavy shell command (headless browser, simtest, Blender, build) waits here until the machine has a free slot
// of its kind (lib/heavy.mjs). It is never refused; it starts later. CAIRN_HEAVY=0 turns the queue off.
// `git worktree remove` on a worktree whose node_modules is a junction to main's follows the junction and deletes
// main's packages: vite, tsc and rolldown's binding gone for every session (notices #53, #72, #73, 2026-10-21/22).
// Refused while the junction is there, with the two-step fix; held once when the path can't be read (a variable).
const WT_REMOVE = /\bgit\b(?:\s+-C\s+("[^"]+"|'[^']+'|\S+))?\s+worktree\s+remove\b([^;&|\n]*)/;
function worktreeGuard(cwd, sessionId, input) {
  // Only a command that runs it: a mention inside quotes or a heredoc (a test, a commit message) is not.
  if (!WT_REMOVE.test(unquoted(input.command))) return null;
  const m = WT_REMOVE.exec(String(input.command || ""));
  if (!m) return null;
  const unq = (s) => String(s || "").replace(/^["']|["']$/g, "");
  const target = m[2].trim().split(/\s+/).map(unq).filter((t) => t && !t.startsWith("-"))[0];
  const deny = (why) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
  const fix = (p) =>
    `Unlink the junction first, then remove the worktree: Bash \`cmd //c rmdir "${p}\\node_modules"\`, ` +
    `PowerShell \`(Get-Item '${p}\\node_modules').Delete()\` (both remove the link only, not main's packages).`;
  if (target && !/[$%`(]/.test(target)) {
    const base = m[1] ? resolve(cwd, unq(m[1])) : cwd;
    const path = resolve(base, target);
    let link = false;
    try {
      link = lstatSync(join(path, "node_modules")).isSymbolicLink();
    } catch {
      /* no node_modules: nothing to follow */
    }
    if (!link) return null;
    log(cwd, `hold worktree remove: ${path} has a node_modules junction`);
    return deny(
      `Cairn refused this command (not Robin): ${path}\\node_modules is a junction to main's node_modules, and git worktree ` +
        `remove follows it and deletes main's packages for every session (it broke main three times). ${fix(path)} Then run it again.`,
    );
  }
  const state = readState(cwd, sessionId);
  const key = "wtremove";
  if ((state.message_held || []).includes(key)) return null;
  state.message_held = [...(state.message_held || []), key].slice(-100);
  writeState(cwd, sessionId, state);
  return deny(
    "Cairn held this command once (not Robin): it removes a git worktree whose path Cairn can't read. If that worktree's " +
      `node_modules is a junction to main's, git worktree remove deletes main's packages for every session. ${fix("<worktree>")} ` +
      "If you've done that (or it has no junction), run the command again and it will go through.",
  );
}

async function heavySlot(cwd, sessionId, input) {
  if (process.env.CAIRN_HEAVY === "0") return null;
  const kind = classify(input.command, repoRoot(cwd));
  if (!kind) return null;
  const { waitedMs, gaveUp, seen, queued } = await waitForSlot(kind, { maxMs: 9 * 60000 });
  if (!queued) return null; // only slow counting, never a real wait
  const s = Math.round(waitedMs / 1000);
  log(cwd, `heavy: ${kind} waited ${s} s${gaveUp ? " and was refused" : ""} (${seen} running, limit ${limit(kind)})`);
  // The limit holds (Robin, 2026-10-27: "make sure we limit our testing instances"): after 9 minutes the run is
  // refused, not started anyway, since one more test run on a full machine can take sessions down with it.
  if (gaveUp)
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Cairn refused this ${kind} run (not Robin): the machine has been full for 9 minutes (${seen} running, limit ` +
          `${limit(kind)}, or free memory under ${MIN_FREE_GB} GB). Work on something else and try again later; prefer the ` +
          "queued `pnpm simtest`, which shares one run between sessions, over a test script of your own.",
      },
    };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `Cairn held this ${kind} run ${s} s in the machine-wide queue (${seen} running, limit ${limit(kind)}; ` +
        "Robin's CPU can't take more at once)." +
        " Prefer one run that checks several things over several runs, and close tools you started once done.",
    },
  };
}

hookMain("pre_tool_use", async (payload, cwd) => {
  if (payload.tool_name === "Bash" || payload.tool_name === "PowerShell")
    return (
      worktreeGuard(cwd, payload.session_id || "unknown", payload.tool_input || {}) ||
      heavySlot(cwd, payload.session_id || "unknown", payload.tool_input || {})
    );
  if (payload.tool_name === "AskUserQuestion")
    return leaveOnlyAsk(cwd, payload.session_id || "unknown", payload.tool_input || {});
  if (payload.tool_name === "SendMessage")
    return messageRule(cwd, payload.session_id || "unknown", payload.tool_input || {});
  if (!EDIT_TOOLS.has(payload.tool_name)) return null;
  const input = payload.tool_input || {};
  const tuning = tuningRule(cwd, payload.session_id || "unknown", input);
  if (tuning) return tuning;
  const file = repoPath(cwd, input.file_path || input.notebook_path || input.path);
  if (!file || file.startsWith(".claude/cairn/")) return null;

  const sessionId = payload.session_id || "unknown";
  const state = readState(cwd, sessionId);
  const warned = new Set(state.overlap_warned || []);
  const holders = otherEditors(cwd, file, { exclude: sessionId, withinMs: HOLD_MS }).filter(
    (o) => o.peer && !warned.has(`${file}|${o.sessionId}`),
  );
  if (!holders.length) return null;

  state.overlap_warned = [...warned, ...holders.map((o) => `${file}|${o.sessionId}`)].slice(-200);
  writeState(cwd, sessionId, state);
  log(cwd, `hold: ${file} (${holders.map(who).join(", ")})`);
  const lines = holders.map(
    (o) => `- [${who(o)}] ${o.peer.status || "open"}, edited it ${ago(o.editedAt)}: ${o.task || "(task not yet known)"}`,
  );
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Cairn held this edit once (not Robin, and nothing is wrong with it): ${file} is held by another open session.\n` +
        `${lines.join("\n")}\n` +
        "Read the file again first (a Write must start from what is there now); that session's uncommitted changes are in it. If this edit is yours by an agreed " +
        "split, make the same edit again and it will go through. If not, message that session by name " +
        "(SendMessage) and agree the split first (docs/WORKING.md section 3).",
    },
  };
});
