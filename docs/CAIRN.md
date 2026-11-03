# Cairn: session memory, live activity and a knowledge graph for agents (npm: `cairn-agent`)

Status: current (2026-11-02). Copied from Seco (2026-10-13, empty store), which had it from the Hollow Hunt repo, which
ported it from Vibus. It differs from
Vibus by dropping session renaming and adding the live-activity board, overlap warnings and checkpoint recall. On
2026-10-06 it gained session names and status from Claude Code, plan tracking, and `cairn report`. On 2026-11-02 it
became project-neutral (per-project settings in `config.json`, below) and gained the knowledge graph.

Cairn gives every Claude Code session here a memory of what other sessions did and are doing. It condenses each
working session into a **checkpoint**, mines each commit for durable **learnings**, tracks which sessions are **live**
and which files they are editing, and feeds all three into sessions' context. The knowledge written by hand
(CLAUDE.md, `docs/`, skills) stays the source of truth. Cairn carries the episodic part: who is in which files right
now, what earlier sessions concluded and left open, and gotchas nobody wrote down.

## Installing

Cairn is the npm package `cairn-agent` (command `cairn`, Node 22.13+). Two ways, which `cairn init` tells apart:

- **In the project** (`npm i -D cairn-agent`, then `npx cairn init --yes`): hooks run
  `node "$CLAUDE_PROJECT_DIR/node_modules/cairn-agent/hooks/<hook>.mjs"`, so the version is pinned with the repo and
  every teammate gets it from `npm install`. Sessions are told to type `npx cairn …`.
- **Globally** (`npm i -g cairn-agent`, then `cairn init --yes`): hooks run `cairn hook <hook>`. Works in any repo,
  including ones with no Node tooling; every teammate installs it once. Sessions are told to type `cairn …`.

`--local` / `--global` force a mode. `init` writes the hooks and the allow rule into `.claude/settings.json`, scopes the
store in `.gitignore`, pins the repo key in `.claude/cairn/config.json`, and adds a tagged line to git's post-commit
hook (in global mode it skips quietly for a teammate without `cairn`). Running it again changes nothing; running it
in a project that copied Cairn as `scripts/cairn/` replaces those hook entries, the old allow rule and the old
post-commit line, and leaves other tools' entries alone. After that the `scripts/cairn/` folder can be deleted; the
store (`.claude/cairn/`) is unchanged.

## What runs when

All hooks are in `.claude/settings.json` (written by `cairn init`). They append context only and always exit 0, with one exception: the PreToolUse hook holds an agent's first edit of a file another open session holds, once (see below). Failures 
go to `.claude/cairn/log/cairn.log`. `CAIRN_DISABLE=1` turns everything off.

| Hook | When | Does |
|---|---|---|
| `hooks/session_start.mjs` | session start, `/clear`, after compaction | seeds ≤6,000 chars: the live board, a one-line index of recent sessions' checkpoints, up to 5 learnings (after a compaction, ranked against the files this session edited; its own checkpoint is no longer restored, since Claude Code's compaction summary covers the whole session); self-heals the install; starts a background knowledge-graph build or update (see Knowledge graph) |
| `hooks/pre_tool_use.mjs` | before `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, and Bash/PowerShell | refuses a `git worktree remove` (a real run, not a quoted mention) while the worktree's node_modules is a junction, since the removal follows it and deletes main's packages, and holds one whose path it can't read once; holds once per file the first edit a session without the tuning role makes to a check (config `checkFiles`, e.g. `src/sim/engine/gate*.ts`, matched on the path's tail so worktree copies count), naming the tuning rule (docs/WORKING.md "Checks and tuning"); if another **open** session edited the file in the last hour, holds this session's first edit of it once (`deny` with a reason naming the holder and saying to re-read, then repeat the edit if the split is agreed or message the holder if not). Answers `allow` in one case only: a SendMessage whose text the unslop pass changed (rewriting a tool's input requires it; that one message skips its permission prompt). Otherwise never, since `allow` would skip the person's own permission prompts |
| `hooks/user_prompt_submit.mjs` | each prompt | marks the session live; ranks only what the person wrote (the IDE's open-file line is stripped, and messages from other sessions, subagent hand-backs and task notifications get no recall); adds up to 3 relevant learnings and, if another session's checkpoint matches the request, that checkpoint in full (each at most once per session; most prompts add nothing); on every prompt Robin wrote (not another session's message or a notification), adds a one-line reminder to check it for feature requests and plan those first, with open decisions asked before building (docs/WORKING.md section 1) |
| `hooks/post_tool_use.mjs` | after `Edit`/`Write`/`MultiEdit`/`NotebookEdit` | records the file on this session's board entry; if the repo has a `docs/AREAS.md` area map (none here yet; parsed by `lib/areas.mjs`), on the session's first edit in an area, names the area's doc (or says it has none yet) and adds up to 3 learnings about it; if another live session edited the same file in the last hour, or plans to, adds a one-time warning naming it and its task (shared with the PreToolUse hold, so a file is flagged once per other session); a plan file records its planned paths instead; if another live session is editing a file tied to this one in the knowledge graph (imports either way, tests, or usually changes with it), a one-time coupling note; with no `docs/AREAS.md`, the area nudge uses the graph's inferred area |
| `hooks/stop.mjs` | end of each turn | if the turn's reply ends with questions for Robin in prose and the turn didn't use AskUserQuestion, sends it back once: questions asking leave to carry on ("Should I go ahead?", "What next?") are told to keep working, real decisions to be asked in the tool (`lib/ask.mjs`: sentences ending in "?" in the closing part of the reply, addressed to the reader or under a questions heading; never twice in a row; `CAIRN_ASK=0` turns it off); likewise when the reply's closing lines say the session is waiting on Robin ("Still waiting on you: …", "Blocked on your call", "Needs your decision"; `waitingOnRobin`, only the session speaking for itself), or hand him a decision as a statement ("… is your decision", "needs your answers", "decisions are yours", "up to you", "once you decide"; quoted text and inline code ignored), and the turn didn't use AskUserQuestion: it is sent back to ask it in the tool; marks the session live; after ≥1 edit and ≥6 turns (or ≥10 turns without edits), over at least 10 minutes or with 3+ edits, writes a checkpoint in the background. A per-session in-flight marker (`inflight/<session>.json`, 90 s) stops a second distill of the same segment; starts a background graph update (at most every 2 minutes) |
| `hooks/pre_compact.mjs` | before compaction | writes a checkpoint synchronously under the same rule as Stop, so other sessions see the work |
| git `post-commit` (`.git/hooks`, re-chained automatically) | each commit | `cairn mine HEAD --detach`: ≤3 verified learnings per 40k chars of diff |

Checkpoints and mining run a headless `claude -p` (Haiku by default, `CAIRN_MODEL`) on your existing login: no API
key. If that fails, checkpoints fall back to a mechanical summary (first prompt, files touched, last reply). Either way the file list comes from the edits the transcript records, not from the model, and the transcript is read only from where the last checkpoint stopped (a byte offset; transcripts here reach 150 MB).

Mining learns from commit messages, so give commits a message that says what and why.

Cairn never renames sessions (the Vibus `Planning/Working/Done - …` renaming was removed). Since 2026-10-06 it
**reads** the names and status Claude Code gives them (`lib/peers.mjs`), so its board uses the same names sessions
use with each other and with SendMessage.

## Live activity (`lib/activity.mjs`)

All sessions share one working tree, so the most useful question is "who else is in these files right now?".
Each session keeps an `activity` entry in its own `state/<session>.json`, written only by its own hooks (so
concurrent sessions never race on it):

- `task`: the first prompt of 15+ characters, replaced by the distilled task once a checkpoint lands. Text the
  harness wraps around a prompt (`<ide_opened_file>`, `<task-notification>`, reminders) is skipped.
- `status`, `open_threads`: from the latest checkpoint.
- `files`: repo paths this session edited, with the time of the last edit (out-of-repo paths are ignored).
- `plan`, `planned`: the latest plan file this session wrote, and the repo paths it names (see below).
- `name`: the session's Claude Code name, kept so a closed session is still known by it.
- `last_active`: bumped by every prompt, edit and turn end.

A session active in the last 6 h is **live**. The seed lists live sessions (name, status, task, last 6 files,
planned files, open threads), open sessions first; a closed one stays only while it left edits behind. `cairn live`
prints the same board. When an edit touches a file another live session edited in the last hour, or one another
session's plan names, the PostToolUse hook tells the agent once per (file, other session): re-read the file, stay in
your task, don't revert the other session's work, and message the session if the split isn't agreed. It runs after
the edit, so it warns rather than blocks.

**Names and status** come from Claude Code's session registry, `<config dir>/sessions/<pid>.json` (config dir is
`CLAUDE_CONFIG_DIR` or `~/.claude`), one file per running session: its id, folder, name (`calerion-chronicles-e9`, or one Robin
gave it, such as `Factions`) and status (`busy`, `waiting`, `idle`). A session missing from the registry shows as
`closed`. Cairn shows sessions as `calerion-chronicles-e9 · 0543bd72`: the name SendMessage takes, then the id its checkpoints
and state file use.

**Plans.** When a session writes a plan file (plan mode, under `<config dir>/plans/`), the hook reads the repo paths
the plan names and stores them as `planned`, separate from `files`: planned is a heads-up, an edit is uncommitted
work at risk. If the plan has a heading with "files" in it, only that section counts. Sub-lists labelled reuse, don't
edit, by request or off limits are skipped, and a bare `town.ts` after `src/sim/geo.ts` on the same line becomes
`src/sim/town.ts`. If any planned path is already edited or planned by another live session, the hook names those
sessions so the split gets agreed before editing starts. The rules for this are in [WORKING.md](WORKING.md).

**`cairn report`** (`lib/report.mjs`) puts the whole board in one read for a person or a coordinating session:
every open session with its status, who is waiting on a human, each session's task, edited and planned files, and
the shared paths: a path (or a folder holding it) that two or more sessions edited in the last hour or plan to
edit. It reads state files and the registry only, never transcripts.

## Heavy runs and the test queue (`lib/heavy.mjs`, `lib/testq.mjs`)

Robin's 16-thread CPU sat at 100% on 2026-10-07 with ten headless browsers and five simtests running at once.

- **The test queue.** The project's test scripts (config `tests`, e.g. `"test": "cairn test simtest"`) run
  `cairn test <name>` (`lib/testcmd.mjs`), which asks `lib/testq.mjs` for a result. A run is good for a request when it started after
  the request, or when no file under config `source` changed since it started (with no `source`, only a fresh run
  counts). At most one run per test and arguments at a
  time; requests made while it runs share the next one. Each run is a detached `testq-run.mjs` that records its exit
  code, so a requester that times out loses nothing. Output goes to stdout as if run directly; queue notes go to
  stderr. Logs and run records: `.claude/cairn/tests/` (last 12 per test). `CAIRN_TESTQ=0` or the `:direct`
  scripts bypass it.
- **The watchdog** (Robin, 2026-10-21, after a run held the queue for two hours). A run whose log has been silent for
  20 minutes (`HUNG_MS`) is hung: the next waiting request records it finished (exit 124, `hung`), ends its process
  tree, posts a notice to the session that started it with the log's path, and lets the next run go. A full simtest
  takes about 55 minutes but writes a line every few seconds. That night's hang came from uncommitted work in the
  shared tree, which every session's tests run: develop slow steps in a worktree.
- **Heartbeats, not process numbers.** A run's runner writes `beat` into its record every 30 s; the run counts as going
  only while the beat is under 2 minutes old, and the watchdog ends a process only when the beat proves it is still
  the runner. After Robin killed the hung run on 2026-10-22, Windows gave its runner's number to an unrelated
  `sleep.exe`, and the queue kept waiting on it (and the watchdog would have ended it).
- **Slots for other heavy runs.** A PreToolUse hook on Bash and PowerShell classifies each command
  (`lib/heavy.mjs`): a headless browser (any node script that imports puppeteer or playwright), `vite build`, and the
  project's own commands and scripts from config `heavy.rules` / `heavy.scripts` (Calerion's were `pnpm shot`,
  `tools/simtest.mjs` and the Blender builds). Quoted text and heredoc bodies are ignored, so mentioning a tool isn't running it.
  When the machine already runs the limit of that kind (browser 2, simtest 2, blender 1, build 1; env
  `CAIRN_MAX_<KIND>`), or free memory is under 6 GB (`CAIRN_MIN_FREE_GB`), the hook waits until a slot frees, up to 9
  minutes, then refuses the run (it used to start anyway; Robin, 2026-10-27: limit our testing instances). Any node run
  with a heap of 4 GB or more (`--max-old-space-size`) counts as a simtest, so test scripts of a session's own take a
  slot too; a simtest that re-spawns itself with a bigger heap counts once. Counts come from the
  live process list (`ps` on macOS and Linux, wmic or PowerShell on Windows), shared between sessions for 5 seconds.
  Free memory on macOS comes from `vm_stat` (free + inactive + speculative + purgeable pages), since `os.freemem()`
  leaves out the file cache and read 2 GB "free" on a 48 GB Mac with 20 GB reclaimable. `cairn slots` shows them;
  `CAIRN_HEAVY=0` turns the slots off.

## Roles, who, jobs and messages (`lib/jobs.mjs`, `lib/report.mjs`)

The rules for using these are in [WORKING.md](WORKING.md) section 2.

- **Roles.** A session's role is what it is for ("world generator", "lore manager"). The prompt hook reads it from
  how Robin introduces the session ("ur the …", "you're the …"); `cairn role "<text>"` sets it. Sessions introduced
  before roles were recorded get theirs from the opening prompts of their transcript (first 256 KB only). The
  board and the report show it, and CLAUDE.md's ownership table is keyed by role.
- **`cairn who "<topic or path>"`** ranks open sessions for a job: a file they edited in the last hour (+6),
  earlier (+2), or plan to edit (+4); a file in a folder they work in (+3); a word in their name or role (+3) or
  task (+1). Lexical, so it can miss; the ownership table is the backstop.
- **Jobs** (`jobs.jsonl`, local, append-only with control rows like learnings): `job add "<title>" --to <role|name|anyone>`,
  `job take|done|decline|note <id>`, `jobs [--all]`. A job matches a session by name, or by role either way round
  (`--to lore` reaches "lore and canon"). The prompt hook shows a session each new job for it once, and shows the
  asker once when its job is finished. The CLI knows which session runs it from `CLAUDE_CODE_SESSION_ID` (`--as`
  overrides). Cairn can't wake a session itself, so `job add` prints the first line for the SendMessage that does.
- **Messages** (`messages.jsonl`, last 1,000): SendMessage stays the transport. The PostToolUse hook (matcher now
  includes `SendMessage`) logs each message a session sends to another session; the prompt hook logs each one that
  arrives, wherever it sits in the prompt (Claude Code puts a line before it). Only the first line is kept, plus
  whether the message said no reply was needed. Each row carries both sessions' ids (`from_id`, `to_id`; a pipe
  address is resolved through the registry's `messagingSocketPath`), and replies are matched by id, so a session
  renamed mid-conversation still gets credit for its reply. The report lists the last 2 hours of traffic and the
  messages older than 15 minutes with no reply.
- **Stale jobs and handing back.** `job release <id> "<why>"` returns a taken job to the queue unfinished. A job taken
  with no take, note or release for 3 h, or open with nobody taking it for 6 h, is listed under "Going stale" in the
  report; the holder is reminded on its next prompt, at most once per 3 h per job.
- **Unanswered messages** count only messages that ask something (a question mark, "please", "could you", …) and
  aren't reports ("done", "committed", FYI, "No reply needed").
- **Notice board** (`notices.jsonl`, last 2 days): `notice "<text>" [--to <role|name|all>]` posts, up to 600
  characters (longer goes in a doc, linked). Each open session is shown each notice once: at session start, on its
  next prompt (a machine one included), or on its next edit, whichever comes first. A poster never sees its own.
  `notices` lists the board; the report shows the last 24 hours.
- **Leave to carry on** (PreToolUse, matcher includes `AskUserQuestion`): a question box whose every question only asks leave to
  carry on (`lib/ask.mjs` `isPermissionQuestion`) is held once with the reason; asking again unchanged goes through,
  for stages Robin wants approved.
- **Message rules** (PreToolUse, matcher now includes `SendMessage`): a message to another session is held once,
  with the reason, when it is over 1,200 characters (put it in a doc), when its first line already went to two other
  sessions in the last 15 minutes (post a notice), or when it is a bare thank-you. Sending it again unchanged goes
  through. Messages to the session's own subagents are never held.

## Unslop: no AI filler in what Cairn keeps (`lib/slop.mjs`)

Added 2026-11-01 (Robin; plan in [design/cairn-unslop.md](design/cairn-unslop.md)). A JavaScript port of
the deterministic pass of [MohamedAbdallah-14/unslop](https://github.com/MohamedAbdallah-14/unslop) (MIT). It fixes
the text rather than flagging it:

- **Session start**: the seed carries a short writing rule (`VOICE_RULE`, `<cairn-memory kind="voice">`).
- **Messages between sessions** (PreToolUse on SendMessage): after the message rules pass, filler is rewritten out
  through `updatedInput`. That needs `permissionDecision: "allow"`, so it is returned only when something changed:
  the one place Cairn answers `allow` (decided 2026-11-02; SendMessage between sessions rarely needs a person's yes).
- **Learnings, notices, threads, checkpoints**: cleaned where they are written (`addLearning`, `addNotice`,
  `addThreads`, `writeCheckpoint`), so `remember`, `mine`, the distiller and the Stop hook are all covered. A
  finishing reply has already been shown to Robin by then; what's cleaned is the copy the next session reads.

It removes sycophancy openers, hedging stacks, stock sentence openers (Furthermore, Moreover, In conclusion…), stock
words (leverage, crucial, seamless, delve into…) and em-dashes past two a paragraph. It never touches code blocks,
inline code, URLs, links, file paths (`src/comprehensive.ts` stays), headings, tables, blockquotes or "quoted" phrases,
and returns clean text byte for byte. Left out on purpose: words that are often literal (realm, landscape, navigate,
journey, vibrant, game-changing), the "However," rule, and unslop's full-level and LLM passes. Config
`unslopLiterals` keeps more words as written. `CAIRN_UNSLOP=0` turns it off.

## Per-project settings (`lib/config.mjs`)

Everything that used to be written into the code for one game lives in the `project` block of
`.claude/cairn/config.json` (committed, next to `repo_key`), merged over neutral defaults. Nothing configured means:
no test queue, no tuning hold, generic heavy-run rules, and messages that say "the user".

```json
{
  "repo_key": "…",
  "project": {
    "person": "Robin",
    "tests": { "simtest": { "kind": "simtest", "command": "node tools/simtest.mjs" },
               "build": { "kind": "build", "command": "tsc --noEmit && vite build" } },
    "source": ["src", "tools", "public", "package.json"],
    "heavy": { "rules": [{ "kind": "browser", "match": "\\bpnpm\\s+shot\\b" }],
               "scripts": { "tools/simtest.mjs": "simtest" }, "limits": { "browser": 2 } },
    "checkFiles": ["src/sim/engine/gate*.ts"],
    "docsCheck": "pnpm docs-check",
    "unslopLiterals": ["crucial"],
    "graph": { "exclude": ["fixtures/**"], "pathAliases": { "@app/*": ["src/*"] } }
  }
}
```

`CAIRN_CONFIG=<file>` points at another config (the selftest uses it).

## Knowledge graph (`lib/graph/`)

Added 2026-11-02 (Robin: "go full knowledge graph; it must be usable for large codebases"). Recall used to be lexical:
a fact was found only if it cited a file you named or shared words with your request. The graph links code and memory,
so a fact about the file next door (one yours imports, or one that changes with it in most commits) is found too,
and says how it was reached.

**What it holds.** One SQLite database (`node:sqlite`, built into Node 22.13+; still no npm dependency) in the main
worktree's `.claude/cairn/graph/`, shared by every worktree. It is derived: delete it and it is rebuilt. Nodes: files,
folders, packages, top-level symbols, commits, and Cairn's memory (learnings, checkpoints, threads, jobs, decisions,
areas, sessions). Edges, all weighted:

| Edge | From | Built from |
|---|---|---|
| imports, references | file → file / package / symbol | regex extractors for JS/TS, Python, Go, Rust, Java/Kotlin/Scala, C#, C/C++, Ruby, PHP; resolution through tsconfig `paths`, workspaces, go.mod, Cargo, Java packages, C# namespaces, composer |
| co_changed | file ↔ file | git history: last 20,000 commits, recent ones weighted more, big commits less, mass formatting and changelogs skipped, renames followed; cosine of the weighted counts |
| tests, documents, mentions | test → file, doc → file, memory → file / symbol | imports from tests plus naming conventions; markdown links and backticked paths and names |
| cites, touched | learning → file / symbol, checkpoint → file | the store |
| owns | area → file | `docs/AREAS.md`, or areas inferred by label propagation over imports and co-change when there is none |

**When it updates.** Never inside a hook. A detached worker (`lib/graph/worker.mjs`) does all writing, one at a time
(lock file with a heartbeat): the first session start builds it, and later session starts, turn ends and commits
(`cairn mine --detach`) start an update at most every 2 minutes. An update reads only files whose git blob id changed,
re-resolves only what those changes affect, and re-syncs memory only when its file changed. A rebuild writes a new
database generation and switches over when it's done, so readers never see a half-built graph.

**What it changes.**
- *Recall* (prompt hook and seed): seeds are the files this session edited, paths and code names in the prompt, and
  name matches; mass spreads up to 3 hops along weighted edges (`lib/graph/query.mjs`) and collects on memory nodes.
  Strength g blends into the lexical score as `relevance = words + max(cited files, 3·min(1.34, 1.5·g))`: it can only
  raise a score, thresholds are unchanged, and structure alone never injects a weak link. A fact found through the
  graph is shown with `(via src/b.ts changes with a.ts (62% of commits); a.ts: you edited it)`.
- *Coupling warnings* (PostToolUse): when another live session is editing a file tied to the one just edited (imports
  either way, tests, or co-change ≥ 0.5), one note per pair says so. No hold.
- *`cairn who`*: sessions working on files close to the job in the graph rank higher.
- *Symbol staleness*: a learning that cites `path#Name` (or names a symbol in backticks while citing its file) records
  the symbol's definition hashes. If the symbol is later removed, renamed (same body, new name) or moved, the fact is
  flagged `[may be stale — \`Widget\` renamed to \`Gadget\` in src/a.ts]`. A changed body alone never flags.
- *Inferred areas*: with no `docs/AREAS.md`, the first-edit note names the inferred area and its learnings.
- *Speed*: hooks read the folded learnings and file churn from the graph instead of re-folding learnings.jsonl and
  running `git log` on every prompt.

**Fallback.** Missing, locked, corrupt, older schema, still building, `CAIRN_GRAPH=0`, or Node without
`node:sqlite`: recall is exactly the lexical recall (the selftest checks this byte for byte).

**Measured** (`cairn graph bench`, M-series Mac, 2026-11-02):

| Repo | Files / commits | Full build | Update, 1 file | Recall p50 / p95 | DB | Held-out recall@20: imports / co-change / both |
|---|---|---|---|---|---|---|
| django | 7k / 35k | 2.0 s | 0.2 s | 12 / 15 ms | 12 MB | 19 / 34 / 40% |
| vscode | 21k / 170k | 15 s | 0.5 s | 15 / 20 ms | 84 MB | 29 / 38 / 44% |
| kubernetes | 32k / 143k | 13 s | 1.5 s | 14 / 25 ms | 99 MB | 35 / 49 / 54% |
| linux | 97k / 1.5M | 90 s (peak 1 GB RAM) | 1.3 s | 13 / 23 ms | 557 MB | 25 / 20 / 33% |

Held-out recall@20: co-change built from history older than the last 500 commits; for each newer commit, one of its
files seeds the walk and the share of its other files in the top 20 is counted. The edge weights were tuned on it.
A first build on a cold disk cache can take several times longer (one Linux build took 10 minutes right after cloning).

## Checkpoint recall

With parallel sessions, the newest checkpoint is rarely about what a new session will do, so the seed no longer
includes one. It lists recent sessions (last 14 days, latest checkpoint each) as one line apiece. The full body
arrives with the prompt that needs it: the prompt hook scores every checkpoint from the last 30 days
(`CAIRN_RECALL_DAYS`) by a named file it touched (+3), a query word in its task (+2) or its body (+1), with crude
stemming and conversational filler dropped. The best one is injected when it scores ≥4 from ≥2 separate hits,
at least one in the task line or a named file. The thresholds were calibrated on 188 real Vibus checkpoints:
"the title screen" and "formation.ts stutter" find the right sessions, while "continue with the next step", "commit
and push" and "add a blacksmith building" find nothing. A session never gets its own checkpoints back, since it
already has that context.

## The store (`.claude/cairn/`)

| File | Committed? | Holds |
|---|---|---|
| `learnings.jsonl` | yes (`merge=union` in `.gitattributes`) | durable facts: text ≤200 chars, cited paths with content hashes, source commit |
| `config.json` | yes | the pinned `repo_key` (here `path:…`, since the repo had no remote at install) |
| `checkpoints.jsonl` | no | one row per distilled segment: task, status, body (done/decided/failed/open), files touched, open threads |
| `state/` | no | per session: live activity, segment marker, what was already shown; swept after 30 days |
| `log/` | no | the hook log, including every overlap warning |
| `graph/` | no | the knowledge graph: `CURRENT` (which generation), `gN.db`, `worker.log`, `lock` |

A learning whose cited file no longer exists is shown flagged `[may be stale — <path> no longer exists]`, never hidden. (Until 2026-10-06 any change to a cited file raised the flag; 84% of facts carried it and agents acted on it 6 times, so it meant nothing.)
Judge it against the code, then `verify <key>` (still true) or `forget <key>` (wrong).

## CLI

`cairn <command>` (global install) or `npx cairn <command>` (installed in the project); the right one is allowlisted in
`.claude/settings.json` by `cairn init`:

- `report [--files n]`: every open session by name, role and status, who waits on a human, shared paths, jobs,
  messages and the ones without a reply, the jobs each session holds, and a "Load" flag when one holds 4 or more
  while an idle session of its role holds none (`loadOf` in `lib/jobs.mjs`). **Run this before starting work** (docs/WORKING.md).
- `who "<topic or path>"`: the right open session for a job. `role "<text>"`: set this session's role.
- `job add "<title>" --to <role|name|anyone> [--file p]... [--detail ..]`, `job take|done|decline|note <id>`,
  `jobs [--all]`: the job queue.
- `notice "<text>" [--to <role|name|all>]`, `notices`: the notice board.
- `land <worktree> [files...] [--dry-run] [--force]` (`lib/land.mjs`): bring a worker's changes onto main by a
  three-way merge per file, all or nothing; refuses conflicts, deletions and files another open session edited in the
  last hour; never stages. docs/WORKING.md, "Landing work from a worktree".
- `overview [--html <file>]` (`lib/overview.mjs`): who is working on what. The Stop hook writes it to
  `.claude/cairn/overview.json` at the end of every session's turn; `--html [file]` fills `assets/overview.html` with
  it, and the commander republishes that page as Robin's Crew Board (https://claude.ai/artifact/LsMsHb1BnXsWQZAyLztSf3;
  a hook can't publish to claude.ai, so the page is as fresh as the commander's last run). The commander's own notes
  for the page are `.claude/cairn/overview-notes.md`.
- `threads [--new|--tracked|--all] [--backfill]`, `thread track|done|drop|reopen <id> "<note>"` (`lib/threads.mjs`):
  the open threads sessions leave. Captured with no effort from sessions: each checkpoint's `open_threads`
  (`lib/lifecycle.mjs`) and the "Open" / "Still open" list at the end of a reply (the Stop hook, `openItems`) go into
  `threads.jsonl`, near-copies folded; a closed thread raised again reopens. The systems session is shown new ones on
  its next prompt and sorts them into docs/design/threads.md. The Crew Board counts them.
- `decide "<| row |>" [--message ..] [--file ..]` (`lib/decide.mjs`): appends one decision row to docs/DECISIONS.md and
  commits that row alone, built from HEAD's copy in a private index, so other sessions' uncommitted rows and the
  shared staging area never ride along; the row also goes after theirs in the working file.
- `live`: other sessions active now: task, files, open threads.
- `learnings <topic-or-path>`: search facts by text and cited paths. **Run this before working in an area.**
- `checkpoints [n] [topic]`: checkpoint bodies, newest first, or ranked by topic.
- `remember "<one sentence>" --ref <path>`: record a durable fact (near-duplicates are folded).
- `verify <key>` / `forget <key>`: keep or retire a flagged fact. `status`: store counts.
- `graph build [--fg] [--full]`, `graph status`: build (in the background unless `--fg`) and inspect the knowledge graph.
  `graph neighbors <path|symbol>`, `graph impact <path>` (what depends on it, its tests, docs, co-changing files and the
  memory about it), `graph query "<text>" [--files a,b]` (the recall pipeline with its score breakdown),
  `graph explain <learning-key>`, `graph path <a> <b>`, `graph areas` (inferred areas as an AREAS.md table),
  `graph export --dot|--json`, `graph bench [--repo p]`.
- `remember "<one sentence>" --ref <path>#<Symbol>`: cite a symbol, so renaming or removing it flags the fact.
- `doctor`: check the installation (graph checks included). `selftest`: hermetic test of the whole thing (run it after
  any change here).
- `mine <ref>`, `gc [--compact]`, `init [--yes]`.

Env: `CAIRN_DISABLE`, `CAIRN_DIR`, `CAIRN_MODEL`, `CAIRN_DISTILL=auto|cli|api|mechanical`, `CAIRN_CLAUDE_BIN`,
`CAIRN_SEED_CHARS`, `CAIRN_MINE_SHARDS`, `CAIRN_RECALL_DAYS`, `CAIRN_DEBUG=1`, `CAIRN_CONFIG`, `CAIRN_GRAPH=0` (graph off),
`CAIRN_GRAPH_AUTO=0` (no background updates), `CAIRN_GRAPH_DB` (pin the database file).

## Limits

- **Commit mining is dormant here:** the repo has no commits yet, so it has never run.
- **Commit mining needs meaningful commits.** Catch-all commits that mix many sessions'
  work yield thin learnings. Checkpoints don't depend on commits and carry most of the value here.
- **Warnings come after the edit.** The overlap warning can't stop an edit, only inform the next ones.
  An area map (`docs/AREAS.md`) is what keeps sessions apart in the first place.
- **A fact can go out of date while its file still exists.** The stale flag catches deleted files and, for facts that
  cite a symbol, a removed, renamed or moved symbol; a fact that a later change to the code made untrue stays
  unflagged until someone runs `forget`. Keep facts about who owns what out of
  learnings: ownership changes within hours and belongs in CLAUDE.md or the report.
- Ranking is lexical plus the graph. The graph finds facts about related files, but a request whose words match
  nothing and that names no file still finds nothing; `cairn checkpoints <topic>` is the manual fallback.
- **Extraction is regex-based**, not a compiler: dynamic imports with computed paths, macros and generated code are
  missed. `graph status` shows the share of imports resolved; unresolved ones are mostly external packages.
- **The session registry is Claude Code's internal file**, not a documented interface. If its shape changes,
  names fall back to bare ids and every session reads as `closed`; nothing else breaks. Plans written before
  2026-10-06 aren't recorded until their session writes the plan again.
