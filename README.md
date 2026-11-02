# cairn-agent

Shared memory, live coordination and a code knowledge graph for [Claude Code](https://claude.com/claude-code)
sessions working in the same repo.

When several sessions work in one repo, each starts blind: it doesn't know what the others are editing, what earlier
sessions found out, or which gotchas cost someone an hour last week. Cairn runs as Claude Code hooks and gives every
session:

- **Memory.** Each working session is condensed into a checkpoint; each commit is mined for durable learnings. The
  relevant ones are added to a session's context when its request touches them.
- **A live board.** Who is editing which files right now. A session about to edit a file another open session is
  working on is told once, and warned when a file it edits is closely tied to one another session has open.
- **Coordination.** Roles, a job queue, messages and a notice board between sessions; `cairn report` shows it all.
- **A knowledge graph** of the code (imports, symbols, which files change together in git, tests, docs) linked to
  that memory. Recall finds facts about the files next to yours, not only the ones you named, and says how it got
  there. Built in the background, sized for large repos (tested on the Linux kernel: 97k files).
- **Machine-wide limits** on heavy runs (headless browsers, long test runs, builds) and a shared test queue.

Plain Node, no dependencies. Needs Node 22.13 or newer (the graph uses the built-in `node:sqlite`).

## Install

Either in the project, which pins the version with the repo:

```sh
npm i -D cairn-agent
npx cairn init          # shows what it will change
npx cairn init --yes
```

or globally, which also works in repos with no Node tooling (every teammate installs it once):

```sh
npm i -g cairn-agent
cairn init --yes
```

`cairn init` writes the hooks and an allow rule into `.claude/settings.json`, scopes Cairn's store in `.gitignore`
(learnings and config are committed and shared; the rest stays on each machine), pins the repo's identity in
`.claude/cairn/config.json`, and adds a line to git's post-commit hook. Then:

1. Add `.claude/cairn/learnings.jsonl merge=union` to `.gitattributes`, so learnings appended on two branches merge
   instead of conflicting.
2. Paste [templates/CLAUDE.cairn.md](templates/CLAUDE.cairn.md) into your CLAUDE.md. Cairn's messages cite a
   `docs/WORKING.md` by section; [templates/WORKING.md](templates/WORKING.md) is a starting point.
3. Start a new Claude Code session. The first one builds the knowledge graph in the background
   (`cairn graph status` to watch).

Coming from a copy of Cairn in `scripts/cairn/`? Install the package and run `init --yes`: it replaces the old hook
entries, allow rule and post-commit line and leaves everything else alone. Then delete `scripts/cairn/`; the store in
`.claude/cairn/` carries on as before.

## Configure

Project settings live in the `project` block of `.claude/cairn/config.json`. Everything is optional.

```json
{
  "repo_key": "github.com/you/your-repo",
  "project": {
    "person": "Sam",
    "tests": { "unit": { "kind": "simtest", "command": "npm run test:unit" } },
    "source": ["src", "package.json"],
    "heavy": { "rules": [{ "kind": "browser", "match": "\\bnpm run e2e\\b" }] },
    "graph": { "exclude": ["fixtures/**"], "pathAliases": { "@app/*": ["src/*"] } }
  }
}
```

| Key | What | Default |
|---|---|---|
| `person` | who the sessions work for, as Cairn's messages name them | "the user" |
| `tests`, `source`, `skip` | the shared test queue (`cairn test <name>`): tests, and the folders whose changes make a finished run stale | none |
| `heavy.rules`, `heavy.scripts`, `heavy.limits` | commands and scripts that count as heavy runs, and how many of each may run at once | puppeteer/playwright scripts, `vite build`, node with a 4 GB+ heap |
| `checkFiles` | check files only a session with the tuning role edits freely | none |
| `docsCheck` | a docs-check command to mention on a session's first edit in an area | none |
| `unslopLiterals` | words Cairn's filler-removal pass must leave alone | none |
| `graph` | `exclude`, `include`, `pathAliases`, `pythonRoots`, `includeDirs`, `cochange`, `query` | see [lib/graph/gconfig.mjs](lib/graph/gconfig.mjs) |

`CAIRN_DISABLE=1` turns Cairn off, `CAIRN_GRAPH=0` just the graph.

## Commands

Use `npx cairn` instead of `cairn` when it's installed in the project.

| Command | What |
|---|---|
| `cairn report` | every open session: role, status, files, jobs, messages waiting for a reply |
| `cairn who "<topic or path>"` | the right open session for a job |
| `cairn learnings <topic>` | what earlier sessions learned about it |
| `cairn remember "<one sentence>" --ref <path>[#Symbol]` | record a learning |
| `cairn job add "<title>" --to <role or name>`, `cairn jobs` | the job queue |
| `cairn notice "<text>"` | post to every session |
| `cairn graph status`, `graph impact <path>`, `graph query "<text>"` | the knowledge graph |
| `cairn doctor` | check the installation |

Full reference: [docs/CAIRN.md](docs/CAIRN.md).

## Develop

```sh
npm test                                   # selftest (hermetic, ~1 min) + extractor tests
node bin/cairn.mjs graph bench --repo ../some-big-repo
```

This repo has no `.claude/settings.json`, so Cairn's hooks don't run while you work on Cairn itself.

## History

Cairn grew inside game projects: Vibus → Hollow Hunt → Seco (2026-10-07) → Calerion Chronicles (2026-10-13 to
10-27), from which it was extracted on 2026-10-31 (commit `42c5a223`). On 2026-11-02 it became project-neutral, gained
the knowledge graph, and was packaged for npm as `cairn-agent`. Some conventions still come from those projects: the
`docs/WORKING.md` sections the messages cite, open threads going to a "systems" session and `docs/design/threads.md`,
and decisions in `docs/DECISIONS.md`.

## License

MIT. `lib/slop.mjs` is a port of part of [unslop](https://github.com/MohamedAbdallah-14/unslop) (MIT); both notices
are in [LICENSE](LICENSE).
