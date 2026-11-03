// Checkpoint lifecycle + garbage collection (docs/CAIRN.md).

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { touch } from "./activity.mjs";
import { distillCheckpoint } from "./distill.mjs";
import { addThreads } from "./threads.mjs";
import { clean } from "./slop.mjs";
import { foldLearnings } from "./rank.mjs";
import {
  addCheckpoint,
  clearInflight,
  dataDir,
  log,
  now,
  readCheckpoints,
  readLearnings,
  readState,
  repoBranch,
  repoKey,
  repoRoot,
  writeCheckpoints,
  writeLearnings,
  writeState,
} from "./store.mjs";
import { readEvents, spanMinutes, stats } from "./transcript.mjs";

// Boundary heuristic (spec 6.3): distill only when the segment since the last
// checkpoint did real work — avoids checkpoint spam from trivial stops. The
// no-edit arm matters: a long research or debugging session that changes no
// files is exactly the session whose conclusions are hardest to re-derive, and
// an edits-only rule left it with no memory at all.
//
// It must also span real time: segments under 5 minutes were 6 of 70 and
// produced the mislabelled checkpoints (review, 2026-10-06). So 10+ minutes, or
// 3+ edits. A segment whose rows carry no timestamps (the fixture) is not held back.
const MIN_SPAN_MINUTES = 10;
const MIN_EDITS_FOR_SHORT = 3;
export function shouldDistill(events) {
  const { assistantTurns, edits } = stats(events);
  const worked = (edits >= 1 && assistantTurns >= 6) || assistantTurns >= 10;
  const span = spanMinutes(events);
  return worked && (span === null || span >= MIN_SPAN_MINUTES || edits >= MIN_EDITS_FOR_SHORT);
}

export function segmentSince(cwd, sessionId, transcriptPath) {
  const state = readState(cwd, sessionId);
  return {
    state,
    ...readEvents(transcriptPath, {
      fromByte: state.last_checkpoint_byte,
      fromLine: state.last_checkpoint_line || 0,
    }),
  };
}

// Distill the segment since the last checkpoint and append the row. Returns the
// row, or null when the segment is empty. Always clears this session's in-flight marker.
export function writeCheckpoint(cwd, { sessionId, transcriptPath, trigger }) {
  try {
    const { events, lineCount, byteCount } = segmentSince(cwd, sessionId, transcriptPath);
    if (!events.some((e) => e.role || e.tool)) return null;
    const d = distillCheckpoint(events, { root: repoRoot(cwd) });
    const row = {
      repo_key: repoKey(cwd),
      session_id: sessionId || "unknown",
      branch: repoBranch(cwd),
      created_at: now(),
      trigger,
      engine: d.engine,
      task: clean(d.task),
      status: d.status,
      body_md: clean(d.body_md), // the finishing message as the next session reads it (lib/slop.mjs)
      files_touched: d.files_touched,
      open_threads: d.open_threads || [],
    };
    addCheckpoint(cwd, row);
    try {
      const a = readState(cwd, sessionId || "unknown").activity || {};
      addThreads(cwd, row.open_threads, { session: row.session_id, name: a.name || "", role: a.role || "", source: "checkpoint" });
    } catch (err) {
      log(cwd, `threads: ${err?.message || err}`);
    }
    // Re-read: the distill above can take tens of seconds, during which this
    // session's hooks keep recording activity into the same state file.
    const id = sessionId || "unknown";
    writeState(cwd, id, { ...readState(cwd, id), last_checkpoint_line: lineCount, last_checkpoint_byte: byteCount });
    // The distilled task and open threads are a better entry on the live board
    // than the prompt the session opened with.
    touch(cwd, sessionId, { checkpoint: row });
    log(cwd, `checkpoint written (${trigger}, ${d.engine})`);
    return row;
  } finally {
    clearInflight(cwd, sessionId);
  }
}

// Housekeeping. Deliberately does NOT expire learnings: the old TTLs deleted
// facts 14 days after a ref-file edit and 30 days after a ref-less `remember`,
// which threw away true, expensively-won knowledge on exactly the hottest files
// (world.ts was cited by 9 learnings, jobBoard.ts by 8). A fact now leaves
// recall only via `cairn forget`. Growth is bounded by write-time dedup instead.
//
// Sweeps per-session state files and caps the local checkpoint log. `--compact`
// additionally rewrites learnings.jsonl folded (duplicates merged, retired rows
// dropped) — the one place that rewrites a committed, merge=union file, so it
// is opt-in rather than automatic.
const STATE_TTL_DAYS = 30;
const CHECKPOINT_KEEP = 200;

export function gc(cwd, { compact = false } = {}) {
  const nowMs = Date.now();
  const days = (iso) => (nowMs - Date.parse(iso)) / 86400000;
  let changed = false;

  const stateDir = join(dataDir(cwd), "state");
  try {
    for (const f of readdirSync(stateDir)) {
      if (!f.endsWith(".json") || f === "distill-inflight.json") continue;
      const p = join(stateDir, f);
      if (days(statSync(p).mtime.toISOString()) > STATE_TTL_DAYS) {
        rmSync(p, { force: true });
        changed = true;
      }
    }
  } catch {
    /* no state dir yet */
  }

  const cps = readCheckpoints(cwd);
  if (cps.length > CHECKPOINT_KEEP) {
    writeCheckpoints(cwd, cps.slice(-CHECKPOINT_KEEP));
    changed = true;
  }

  if (compact) {
    const raw = readLearnings(cwd);
    const folded = foldLearnings(raw);
    const rows = folded.map((l) => ({
      id: l.id,
      key: l.key,
      repo_key: repoKey(cwd),
      text: l.text,
      source: l.sources[0] || "manual",
      sources: l.sources,
      corroborations: l.corroborations,
      refs: l.refs,
      ref_hashes: l.ref_hashes,
      ...(l.sym_refs && Object.keys(l.sym_refs).length ? { sym_refs: l.sym_refs } : {}), // symbol baselines survive compaction
      created_at: l.created_at,
      last_verified_at: l.last_verified_at,
      status: "verified",
    }));
    if (rows.length !== raw.length) {
      writeLearnings(cwd, rows);
      changed = true;
    }
  }
  return changed;
}
