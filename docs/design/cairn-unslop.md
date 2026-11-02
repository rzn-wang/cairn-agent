# Cairn + unslop

Status: Decided and built (Robin, 2026-11-01). How it works now: [../CAIRN.md](../CAIRN.md), "Unslop".
Question this answers: how Cairn uses [MohamedAbdallah-14/unslop](https://github.com/MohamedAbdallah-14/unslop)
(MIT) to keep the text it stores and relays free of AI filler.

## What unslop is

- A short voice rule (`rules/unslop-activate.md`, about 20 lines) that its SessionStart hook injects into every
  session: drop sycophancy, stock words (delve, tapestry, seamless, leverage…), hedging stacks, tricolons,
  em-dash pileups; keep technical terms, code and errors exact; code, commits and PRs are written normally.
- A Python package (`unslop/scripts/`, about 6,700 lines) with a deterministic regex pass (`humanize.py`, levels
  subtle / balanced / full), a validator, and optional LLM rewrites.
- Statusline badge and mode tracker hooks (`/unslop full`, `stop unslop`).

## Where it meets Cairn

Cairn writes and passes on prose that later sessions read as memory:

| Text | Where Cairn handles it |
|---|---|
| Learnings (`cairn remember`) | `scripts/cairn/cairn.mjs`, `lib/store.mjs` |
| Notices | `lib/jobs.mjs` `addNotice` |
| Messages between sessions | `hooks/pre_tool_use.mjs` (already holds a message once for breaking the message rules) |
| Finishing messages / checkpoints | `hooks/stop.mjs`, `lib/distill.mjs` |
| Session-start context | `hooks/session_start.mjs` |

## First layer

1. `scripts/cairn/lib/slop.mjs`: a small JavaScript port of unslop's balanced-level patterns (stock words,
   sycophancy openers, hedging stacks, em-dash cap), so Cairn keeps its "plain Node, no dependencies" rule.
   Returns the hits with their positions; masks code, paths and URLs first.
2. Session start: Cairn adds unslop's voice rule (adapted, with credit) to the context it already injects.
3. Messages between sessions: one more reason for the existing hold-once (Cairn tells the session which phrases
   to cut; resending unchanged still goes through).
4. Selftest cases for each pattern and for the code/path masking.

Later: learnings and notices, the finishing-message check, and an optional bridge to the Python package for full
rewrites.

## Files

- New: `scripts/cairn/lib/slop.mjs` (the port and the adapted voice rule, MIT credit)
- Change: `scripts/cairn/hooks/session_start.mjs`, `scripts/cairn/hooks/pre_tool_use.mjs`, `scripts/cairn/lib/store.mjs`,
  `scripts/cairn/lib/jobs.mjs`, `scripts/cairn/lib/threads.mjs`, `scripts/cairn/lib/lifecycle.mjs`,
  `scripts/cairn/lib/selftest.mjs`, `docs/CAIRN.md`, `docs/WORKING.md` (section 3 message rules)
- Don't edit: Kingdom game code (`packages/`, `apps/`)

## Decisions (Robin, 2026-11-01)

1. **Port the core patterns to JavaScript inside Cairn** (not the Python package, not the plugin alongside).
2. **All four kinds of text**: session-start voice rule, messages between sessions, learnings and notices, finishing
   messages (as the stored checkpoint; the reply on screen can't be changed after the fact).
3. **Fix, not flag**: Cairn rewrites the text itself with the deterministic pass.
