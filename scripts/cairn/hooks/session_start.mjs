// SessionStart (matcher startup|clear|compact — resume keeps its context, so we
// don't register for it): self-heal the unversioned install bits, emit the
// seed, then do opportunistic gc.
//
// Race handling: if the previous session's Stop hook left a fresh in-flight
// distill marker, wait up to ~2s for the checkpoint to land; if it still hasn't,
// seed what exists and say a checkpoint is pending. Must stay well under the
// hook timeout — the seed itself is pure JSONL reads.

import { touch } from "../lib/activity.mjs";
import { buildSeed, envelope } from "../lib/context.mjs";
import { noticeNews } from "../lib/jobs.mjs";
import { hookMain } from "../lib/hook.mjs";
import { selfHeal } from "../lib/install.mjs";
import { gc } from "../lib/lifecycle.mjs";
import { inflightAgeMs, readState, writeState } from "../lib/store.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

hookMain("session_start", async (payload, cwd) => {
  try {
    selfHeal(cwd);
  } catch {
    /* healing must never block the seed */
  }

  let distillPending = false;
  for (let waited = 0; waited < 2000; waited += 100) {
    const inflightAge = inflightAgeMs(cwd);
    if (inflightAge === null) break; // no marker: nothing pending
    if (inflightAge > 15000) break; // stale marker: distill died
    distillPending = true;
    await sleep(100);
  }
  if (distillPending && inflightAgeMs(cwd) === null) distillPending = false;

  const sessionId = payload.session_id || "unknown";
  const selected = [];
  let seed = buildSeed(cwd, { source: payload.source, distillPending, selected, sessionId });
  try {
    touch(cwd, sessionId);
    // Remember what the seed already carries so the prompt hook doesn't repeat it.
    const state = readState(cwd, sessionId);
    state.prompts_seen = [...(state.prompts_seen || []), ...selected];
    // A new session reads the recent notice board once, here.
    const board = noticeNews(cwd, sessionId, state);
    if (board) seed = [seed, envelope("notices", board)].filter(Boolean).join("\n");
    writeState(cwd, sessionId, state);
  } catch {
    /* state is an optimization, never a blocker */
  }
  try {
    gc(cwd);
  } catch {
    /* gc is best-effort */
  }
  if (!seed) return null;
  return {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: seed },
  };
});
