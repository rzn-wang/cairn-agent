# Cairn

Session memory, live activity and coordination for Claude Code sessions sharing one repo: checkpoints of what each
session did, learnings mined from commits, a live board of who is editing what, jobs/messages/notices between
sessions, a shared test queue and machine-wide slots for heavy runs. Plain Node (ES modules, `node:` built-ins only,
no dependencies). Full description: [docs/CAIRN.md](docs/CAIRN.md).

## Where this copy came from

Extracted 2026-10-31 from **Calerion Chronicles**, branch `main`, commit `42c5a223` (Cairn's last change there:
`ca6b5405`, 2026-10-27). The files are byte-for-byte that commit's `scripts/cairn/`, `docs/CAIRN.md` and
`docs/WORKING.md`, with LF line endings. The data store (`.claude/cairn/`) was **not** copied: it is
Calerion's sessions, jobs and learnings, and its `config.json` pins Calerion's repo key.

Lineage: Vibus → Hollow Hunt → Seco (2026-10-07) → Calerion Chronicles (copied 2026-10-13, then developed to
2026-10-27). Calerion's copy is newer than Seco's: it adds `lib/decide.mjs`, `lib/land.mjs`, `lib/overview.mjs`,
`lib/threads.mjs` and `overview.html`, and changes most hooks.

## Layout

The paths mirror where Cairn sits in a project, so it drops straight in:

| Path | What |
|---|---|
| `scripts/cairn/` | the code: `cairn.mjs` (CLI), `hooks/` (Claude Code hooks), `lib/`, `test.mjs` (test-queue front end), `fixtures/` (for the selftest) |
| `docs/CAIRN.md` | how it works (its header still says "current 2026-10-13"; the code ran on to 2026-10-27, so the doc lags a little) |
| `docs/WORKING.md` | Calerion's working rules; the hooks cite its sections by number |
| `snippets/CLAUDE.cairn.md` | the `<!-- cairn:begin -->…<!-- cairn:end -->` block for a project's CLAUDE.md |

## Installing into a project

1. Copy `scripts/cairn/` (and `docs/CAIRN.md`, plus a `docs/WORKING.md` of your own) into the project.
2. From the project root: `node scripts/cairn/cairn.mjs init` to see the changes, then `init --yes` to apply. It
   writes the hooks and permission rule into `.claude/settings.json`, scopes the store in `.gitignore`, pins the
   repo key in `.claude/cairn/config.json`, and chains `cairn mine` onto git's post-commit hook.
3. Paste `snippets/CLAUDE.cairn.md` into the project's CLAUDE.md.
4. To use the test queue, point the project's scripts at it, as Calerion does:
   `"build": "node scripts/cairn/test.mjs build"`, `"simtest": "node scripts/cairn/test.mjs simtest"`.
5. Hooks take effect from the next Claude Code session. `CAIRN_DISABLE=1` turns everything off.

This repo itself has no `.claude/settings.json`, so Cairn's hooks don't run while you work on Cairn.

## Tied to Calerion (edit these for another project)

- `lib/testq.mjs` `TESTS`: `simtest` = `node tools/simtest.mjs`, `build` = `tsc --noEmit && vite build`; `SOURCE`
  lists the folders whose changes invalidate a finished run (`src`, `tools`, `public`, …).
- `lib/heavy.mjs`: what counts as a heavy run (puppeteer tools, `pnpm shot`, Blender `pnpm build:kit` etc.,
  `tools/simtest.mjs`) and the limits (browser 2, simtest 2, blender 1, build 1; 6 GB free). Slots are
  machine-wide, shared with Seco.
- `hooks/pre_tool_use.mjs`: the tuning-role hold on check files (`src/sim/engine/gate*.ts`,
  `tools/worldgen-sweep.mjs`), and the refusal of `git worktree remove` while node_modules is a junction.
- `hooks/post_tool_use.mjs`: points at `docs/AREAS.md`, `docs/design/<topic>.md` and `pnpm docs-check`.
- `hooks/user_prompt_submit.mjs` and `lib/threads.mjs`: open threads go to the "systems" session and
  `docs/design/threads.md`; the feature-request reminder on every prompt.
- `lib/ask.mjs` and `hooks/stop.mjs`: the question and "waiting on you" detection names Robin.
- `lib/decide.mjs`: writes decisions to `docs/DECISIONS.md`. `lib/land.mjs` cites `docs/WORKING.md`.
- Messages throughout cite `docs/WORKING.md` sections by number.

## Testing

```sh
node scripts/cairn/cairn.mjs selftest
```

It uses its own temporary store, but it writes a scratch file under `.claude/` at the repo root, so that folder has
to exist (create an empty one when running it here). 171 checks passed on extraction.
