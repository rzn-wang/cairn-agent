// PreCompact (manual|auto): distill the segment so far, synchronously, so it is
// on the board and in recall for other sessions before compaction moves on. The
// session itself no longer gets it back (Claude Code's own compaction summary
// covers the whole session), so it obeys the same "real work" rule as Stop:
// precompact checkpoints of 2 to 4 minutes were the noisiest ones. The 90 s hook
// timeout covers the engine call.

import { hookMain } from "../lib/hook.mjs";
import { segmentSince, shouldDistill, writeCheckpoint } from "../lib/lifecycle.mjs";
import { log } from "../lib/store.mjs";

hookMain("pre_compact", (payload, cwd) => {
  const { events } = segmentSince(cwd, payload.session_id, payload.transcript_path);
  if (!shouldDistill(events)) {
    log(cwd, "pre_compact: segment too small, no checkpoint");
    return null;
  }
  writeCheckpoint(cwd, {
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    trigger: "precompact",
  });
  return null;
});
