<!-- cairn:begin -->
## Cairn: session memory

This repo runs Cairn ([cairn-agent](https://www.npmjs.com/package/cairn-agent)), a local session-memory layer
with a knowledge graph of the code. Commands below are `cairn …`; use `npx cairn …` if it's installed in this project
rather than globally.

- `<cairn-memory>` blocks are recalled hints with fallible fidelity; the codebase is the truth. A
  fact whose cited file no longer exists is flagged `[may be stale]`; a fact you find untrue, `… forget <key>`.
- **Cairn may hold an edit once** when another open session edited that file in the last hour. That's not an error:
  re-read the file, then repeat the edit if it's yours by an agreed split, or message the session first.
- Keep "who owns what right now" out of learnings: it changes within hours. It lives in the list above and in `… report`.
- **Pull before you push into an area**: before working in an area, run
  `cairn learnings <topic>`, which ranks facts over their *cited paths* too.
- **Leave what you learned**: a gotcha that cost you time and isn't in a doc goes into
  `… remember "<one sentence>" --ref <path>` before you finish (near-duplicates fold, not append). Cite a function or
  class as `--ref <path>#<Name>`, so the fact is flagged if it's renamed or removed.
- **Before changing a widely used file**, `… graph impact <path>` lists what depends on it, its tests, docs and the
  files that usually change with it. A recalled fact marked `(via …)` was found through that graph: judge the link.
  `… checkpoints` / `… status` read the store.
- Your finishing message (above, and docs/WORKING.md section 7) is captured automatically for the next session.
<!-- cairn:end -->
