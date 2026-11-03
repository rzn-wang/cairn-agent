# Changelog

## 0.1.1

- Heavy runs and the test queue no longer wait forever on machines with less than about 8 GB of memory: the
  free-memory floor is now 6 GB or 30% of the machine's memory, whichever is lower (`CAIRN_MIN_FREE_GB` still sets
  it exactly). Found by the macOS CI runners, which have 7 GB.

## 0.1.0

First npm release, as `cairn-agent` (command: `cairn`). Before this, Cairn was copied into each project as
`scripts/cairn/`.

- **Install as a package**, globally (`npm i -g cairn-agent`) or per project (`npm i -D cairn-agent`). `cairn init`
  detects which and wires the Claude Code hooks to it; it also migrates a copied `scripts/cairn/` install.
- **Per-project settings** in `.claude/cairn/config.json` (`project` block) instead of code edits: test commands,
  heavy-run rules, check files, the person's name, words the filler pass keeps.
- **Knowledge graph** (`lib/graph/`, needs Node 22.13+): files, imports, symbols, git co-change, tests and docs,
  linked to Cairn's memory. Recall finds facts about related files and says how; coupling warnings between
  sessions; `cairn who` by code proximity; symbol-level staleness; inferred areas; `cairn graph …` commands.
- **Unslop**: filler removed from what Cairn stores and relays (port of unslop's deterministic pass, MIT).
- Faster recall at scale: learnings folded with a token index, no file hashing or `git log` per prompt.
- macOS and Linux support for heavy-run slots (`ps`, `vm_stat`).
