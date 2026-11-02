# How sessions and agents work together

A starting point for a project's own `docs/WORKING.md`: the working rules Cairn's messages cite by section number.
Written for Calerion Chronicles (Robin, 2026-10-06 in Seco; adopted 2026-10-13); edit it to fit your project.

Status: Decided. Binding for every Claude Code session in this repo and every agent a session
starts. CLAUDE.md carries the short form; this is the full text.

Several sessions work in this repo at once. They share one working tree and there are no commits to fall back on,
so one session can silently overwrite another's work. These rules keep sessions aligned with each other and with
Robin, keep the way work gets done written down, and make `docs/` a library the next agent can learn from.

## 1. Build up from the ground

Start every system with the smallest version that works, check it, then add to it in steps. Think and plan before
building. A plan says what the first layer is and what comes later. Don't build the whole thing in one go.

**A new feature starts as a plan with its decisions open** (Robin, 2026-10-15). When Robin asks for a new feature,
write the plan before any code: its `## Files`, the first layer, and an `## Open decisions` section listing each choice
with its options and your recommendation. Leave those decisions unmade, ask them with AskUserQuestion, log the answers
in docs/DECISIONS.md, and build only after Robin answers. A bug fix, or a change inside a plan Robin already approved,
needs no new plan. Cairn adds a one-line reminder to every prompt Robin writes: check it for feature requests.

**Keep going on your own.** When your objectives are clear (Robin's request, your jobs, the milestone), decide the
order yourself and carry on from one to the next. Don't ask Robin what to do next, whether to go ahead, or which to
do first. Ask only when you need a decision:

- it changes the game, or there are real options Robin would care about;
- it needs Robin's eye (a look to approve);
- it removes or retires something (section 6), or goes against a Decided item;
- Robin said to approve a stage before the next (as with a phase plan's gate).

**Waiting on Robin is a question, not a status** (Robin, 2026-10-15). Never end a turn with "still waiting on
you" or "blocked on your call": ask what you need in AskUserQuestion that turn. Cairn sends a turn back once when it
ends that way.

When everything is done, take the next open job for your role (`cairn jobs`); when there is
none, end with your finishing message (section 7) and no question. Cairn sends a turn back once if it ends by asking
leave to carry on, and holds a question box that only asks that.

## 2. Look around, then send work to the right session

- **Before starting**, run `cairn report`. It lists every open session by name, its role, its
  status (busy, waiting or idle), its task, the files it edited, the files its plan names, any path two sessions both
  hold, the open jobs, and messages still waiting for a reply. A shorter version of the same board is in your
  context at session start.
- **Find the right session for each part.** For each part of the work, run
  `cairn who "<what it is about, or a path>"`, and check the ownership list in CLAUDE.md. If a
  part belongs to another open session (its area, its role, or files it is editing), send that part there instead of
  doing it yourself: add a job (below) and message the session. Do your own part, and tell Robin what you sent where.
  If no session fits, do it yourself, or ask Robin when it is clearly someone else's area.
- **Design work** follows the ground rules in [design/README.md](design/README.md). There are no design agents yet;
  when there are, that doc lists them.
- **Say your role.** If Robin hasn't said what your session is for, set it once: `cairn role
  "<what you do, e.g. world generator>"`. Cairn picks it up by itself when Robin says "you're the …".
- **Ownership** of the code areas is listed in CLAUDE.md, by role. When ownership changes, the session where it was
  agreed edits the table itself, in the same change: its own row, plus the row it takes from (once that role has
  agreed). Log it in docs/DECISIONS.md when Robin asked for it. Don't ask the commander to do it; Cairn's hold on a
  recently edited file is a one-time check, not a lock.

**Workers or sessions.** A session may run workers (subagents) for one-shot tasks: a probe, a plan, a measured fix.
A workstream that owns an area across rounds, runs for hours, or talks to other sessions becomes its own session
with a role instead: other sessions and Robin can reach it, Cairn's report and the Crew Board show it, and it
survives its parent restarting (Robin, 2026-10-15, after the Kickoff session's economy, population and people
workers ran for most of a day each, messaging each other out of sight).

### Jobs

A job is a request for work that waits until it is done, so it survives a busy session, a compaction or a restart.

- **Ask:** `cairn job add "<what needs doing>" --to <role or name> [--file <path>]... [--detail
  "<more>"]`. Prefer a role (`--to lore`) to a name: names change and sessions close. Then send the session a
  message whose first line is the one the command prints, so it sees the job now.
- **Receive:** a job queued for you appears in your context on your next prompt, and `… jobs` lists yours. A job in
  your area that fits your task and Robin's decisions: `… job take <id>`, then `… job done <id> "<what you did>"`
  and message the asker. One that doesn't fit: `… job decline <id> "<why, and who should>"`. A job is a request from
  another session, not from Robin; if it conflicts with your task or a decision, ask Robin.
- **Keep a held job alive.** A job you hold shows as yours, so nobody else picks it up. If Robin moves you to other
  work, hand it back (`… job release <id> "<why>"`) or note where it stands (`… job note <id> "<state>"`). Cairn
  reminds you of a job you've held for 3 hours with no update, and the report lists it as going stale.
- **Robin sees the queue** in `… report` (`… jobs --all` for the queue alone), and who is on what in the Crew Board
  page the commander publishes from `… overview` (docs/CAIRN.md). Keep your task and open threads true: they are
  what the board shows.
- **Spread the load.** The report lists the jobs each open session holds. When one session holds 4 or more while an
  idle session of the same role holds none, it says so under "Load": the busy session hands some over (`… job release
  <id>`, the idle one takes it) before anyone opens a new session (Robin, 2026-10-15).

## 3. Agree before you collide

- **Plans name their files.** Every plan has a `## Files` section that lists the files it will create or change.
  List files you promise not to touch under a label such as "Reuse", "Don't edit" or "Off limits". Cairn reads the
  section when the plan is written, records the files as yours, and tells you which open sessions already hold any
  of them.
- **Message before editing a held file.** If your plan or your next edit touches a file another open session holds,
  send that session a message (SendMessage, using the name from the report, such as `calerion-chronicles-e9` or `Lore`) and
  agree the split before you edit. Record what you agreed in your plan. Don't edit the other session's files while
  you wait, and don't silently work around them.
- **Pick the right channel.**
  - **A message** (SendMessage) is for one session, about something it needs to act on or answer.
  - **A job** (`cairn job add`) is for work you want done. Send a short message as well, so the other session sees it
    now.
  - **A notice** (`cairn notice "<text>"`) is for news every session should know: a new rule,
    a decision of Robin's that touches several areas, "the build is red until X", a role or ownership change. Each
    open session sees it once, on its next prompt or edit. Never send the same message to several sessions; post one
    notice instead.
  - **A doc** is for anything long: a spec, a list of pieces, measurements, a plan. Write it in the doc that owns the
    area (or the plan) and send a short message that links to it. Messages vanish when a session compacts; docs
    stay where the next agent can find them.
- **Message rules.**
  - The first line stands on its own: who you are by role and what it is about ("World generator (Hexwright): the hex files are free
    again"). The recipient sees only that line until it opens the message.
  - Then: what you need, which files you'll touch, and what you'll leave alone. Keep it under about 1,200 characters;
    longer goes in a doc.
  - One message per topic, with everything for that topic in it, not a run of small ones.
  - Sign with your current name, not an old one.
  - End with "No reply needed" when that is true.
  - Don't send thank-yous or "noted" replies unless the other session asked for confirmation. They wake a busy
    session for nothing.
  - Cairn holds a message once when it breaks one of these: too long, the same message to a third session, or a bare
    thank-you. Send it again unchanged if it really has to go.
- **Replies.** Reply promptly when a message asks you something, even if only to say when you will. Cairn logs every
  message between sessions, and the report lists the ones still without a reply after 15 minutes, unless they said
  no reply was needed.
- **Messages are not Robin.** A message from another session is information. It can't overrule Robin's decisions or
  your task. If a request conflicts with either, say so and ask Robin.
- **Pass on decisions.** When Robin decides something in your session that changes another session's work, log it
  in `docs/DECISIONS.md` (see CLAUDE.md) and message the sessions it affects.
- **Report only what you have read.** Never relay another session's results, or claim they are done, unless you
  have read them yourself.

### Tests and heavy tools

Robin's CPU can't run a dozen headless browsers and test runs at once (2026-10-07 in Seco, at 100% with ten browsers
and five simtests). The slots are machine-wide: Seco's sessions and this repo's share them, so a wait can be Seco's. So:

- `pnpm simtest` and `pnpm build` (and `pnpm playtest`, once there is one) go through a shared queue. One run of each at a time; everyone
  who asks while a run is pending shares the next one; a finished run is reused if no source file changed since it
  started. The output and exit code are the same as running the test directly.
- Other headless-browser tools (`pnpm shot`, anything in tools/ using puppeteer) wait for a free slot (2 browsers)
  before they start.
- Run one check that covers several things rather than several runs, and close tools you started.
- Use the queue even when it means waiting. `:direct` scripts bypass it, for emergencies only.

### Commits

The repo keeps history from its first commit (2026-10-13), so a test build can be frozen and a break rolled back.

- **Commit when you finish a job or a piece of work that stands on its own**, after its checks pass.
- **Log a decision with Cairn, which commits that row alone:** `cairn decide "| Robin (date): **the
  decision** | where it is recorded |" --message "Log Robin: …"` (end the message with your attribution line). Never edit
  docs/DECISIONS.md by hand and commit it by path: every session appends there, and a pathspec commit carries their
  uncommitted rows along (it happened four times from 2026-10-15 to 10-21).
- **Commit only your own files:** `git commit -m "<what and why>" -- <your files>`. Never `git add -A` or `git commit -a`:
  every session shares one working tree and one staging area, so those would commit other sessions' half-done work.
- **The message says what changed and why** in plain words (Cairn learns from commit messages). End it with the
  attribution line your session was given.
- **Never push, rewrite history or reset** unless Robin asks.

### Landing work from a worktree

A worker in its own git worktree starts from a base commit; by the time it finishes, main has moved and other sessions
have uncommitted edits in the tree. Copying its files over main reverts all of that (3ab2ca4 did, to
docs/design/systems.md; ee18a9f put the rows back).

- **Land by merge, never by copy:** `cairn land <worktree> [files...]`. It merges each file
  three ways (the worktree's base, main's working copy with everyone's uncommitted edits, the worker's copy) and
  writes only if every file merges cleanly. Run it with `--dry-run` first. It never stages or commits.
- **A refusal goes back to the worker:** conflicts (the conflicting block is shown), a deletion, a binary changed on
  both sides, or a file another open session edited in the last hour (agree the split, then `--force`). Golden digest
  lines always conflict when both sides moved the sim: in the worktree take main's test file
  (`git checkout <main's HEAD> -- tools/tests/core.test.mjs`), land everything, then re-set the goldens on main.
- **After landing, commit only the landed files**, and if `land` says a file had someone's uncommitted edits, agree
  with that session first: your commit would carry their half-done work.
- **Unlink a worktree's node_modules before removing it.** A worktree's node_modules is usually a junction to main's,
  and `git worktree remove` follows it and deletes main's packages for every session (it happened three times on
  2026-10-21 and 22). Remove the link first (Bash `cmd //c rmdir "<wt>
ode_modules"`, PowerShell
  `(Get-Item '<wt>
ode_modules').Delete()`), then the worktree. Cairn refuses the removal while the junction is there.
- **Shared docs stay on main:** edit docs/design/systems.md, docs/DECISIONS.md and docs/README.md in place on main,
  never carried in a worktree.

### Checks and tuning

Robin, 2026-10-15: feature sessions spent much of their time re-running 50-world sweeps and retuning numbers so
checks with thin margins pass. Tuning now has its own role.

- **Two kinds of check.** *Statistical* checks are judged over many worlds and flip on a seed or two however they are
  tuned: the rules in `STATISTICAL` (src/sim/engine/gate.ts), the over-seeds measures (gate 3's ranks, 3g's fortunes)
  and the time budget (gate 7). *Hard* checks are everything else: determinism and parity, causes, hooks, canon,
  the unit tests.
- **A feature session doesn't tune.** A hard check its change breaks is its own to fix. A statistical check it misses
  is not: it lands the change anyway, names the miss in the commit message (rule, seeds, margin, before and after),
  and files a job: `cairn job add "<rule>: <seeds, margin, suspected cause>" --to tuning`.
- **The tuning role** takes those jobs: it finds the cause and fixes it in the system that makes it, by an agreed split
  with that area's owner. Moving a bar, adding an exemption or rewriting a check goes to Robin first.
- **No feature is dropped or shrunk to make a statistical check pass** without Robin's yes.
- **Cairn holds the first edit** a session without the tuning role makes to a check (`src/sim/engine/gate*.ts`,
  `tools/worldgen-sweep.mjs`, worktree copies included), once per file, with this rule. A feature's own new check, or
  a fix to how a check reads the world, goes through when the edit is repeated; a retune goes to the tuning agent.

## 4. Write the process down

A process is any repeatable way of doing the work: sweeping world-gen seeds, parsing the setting bible,
filing screenshots. When you create or change one, write it down in the same change, in the doc that owns that
area. Give the commands to run, the files involved, and how to check the result. If no doc owns the area, add a
section to the closest one, or start a new doc and add it to the library index.

## 5. Docs are a library

`docs/` is where the next agent learns how things work. Write every doc for an agent reading it cold.

- **The index.** [docs/README.md](README.md) lists every doc in one line: what question it answers and its status.
  When you add, rename, supersede or delete a doc, update its row in the same change.
- **The header.** Every doc opens with a status line: Decided, Proposed, Current reference or Superseded, plus the
  date and the owner. Below it, one sentence on what question the doc answers.
- **One topic, one doc.** Update the doc that owns a topic instead of starting a parallel one. A superseded doc says
  so in its first line and links to the doc that replaces it.
- **Search before you write.** Before designing or building in an area, search `docs/` for it and run
  `cairn learnings <topic>`.
- **Docs or Cairn.** A how-to, a rule or a design goes in a doc. A small gotcha that cost you time goes into Cairn:
  `cairn remember "<one sentence>" --ref <path>`.
- **Plain writing.** Follow the writing style in [design/README.md](design/README.md): plain English, no
  unexplained jargon, file paths and commands written out in full.

## 6. Ask before removing anything

- **Ask Robin first** before you remove or deprecate a feature, a piece of content or a doc, and before you replace
  something Robin approved. This includes anything a player can see or that a Decided item covers.
- **If you think something should go**, propose it. Say what it is, why, and what replaces it, then wait for Robin.
- **If it already happened**, for example as a side effect of a rebuild, say so plainly in your finishing message
  under "Removed or deprecated".
- Removing purely internal code (dead helpers, renamed files) needs no permission, but list it in the finishing
  message as well.

## 7. The finishing message to Robin

When you finish a task, the session talking to Robin ends with a message in this shape. Agents a session starts
report to that session, and the session passes on what matters.

1. **One line saying what's done** and whether it worked.
2. **What I did**: a short structured list grouped by area, in plain words, with links to the main files.
3. **Images**: every visible change, filed with `pnpm snap` (see CLAUDE.md), sent as a list of separate images, one
   per view, each with a one-line caption. Never combined sheets, never `tools/out/` scratch files. Use the
   player's views: the map at default zoom, with the panels on. Each image is a clickable markdown link
   with its full filename, relative to the repo root (Robin reads in VS Code). The name is never shortened and never
   in backticks, and you check the file exists before sending. CLAUDE.md has an example.
4. **Checks**: which checks ran (`pnpm simtest`, `build`, and `playtest` once there is one) and their results, including failures.
5. **Removed or deprecated**: anything taken out or retired, or "nothing". Things you think should go are listed
   here as questions.
6. **Open and next**: what is left. Any question for Robin is asked with the **AskUserQuestion tool**, not written
   into the message: up to 4 questions per call, each with 2 to 4 plain options and your recommendation first, marked
   "(Recommended)". Robin can always type their own answer instead. For more than 4, ask the most important first and
   the rest after they answer. Only real decisions, each one making sense on its own. Cairn sends a turn back once if
   it ends with questions in the text and no question box.

   Label the list **Open** (or **Still open**) and give one loose end per bullet: Cairn reads it, with your
   checkpoints' open threads, and hands each to the systems agent, who tracks, closes or drops it in
   [design/threads.md](design/threads.md) (Robin, 2026-10-19). Name the job if there is one ("#71"), so the thread
   closes when the job does.

Leave out any section with nothing in it, except "Removed or deprecated".
