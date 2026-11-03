#!/usr/bin/env node
// cairn (npm: cairn-agent) — session memory, coordination and a knowledge graph for Claude Code sessions sharing
// a repo (docs/CAIRN.md).
// Zero dependencies. Commands:
//   init [--yes]      install hooks/settings/gitignore/post-commit (idempotent;
//                     session_start self-heals the unversioned bits every session)
//   status            store counts, repo_key, branch
//   live [--session id]  other sessions active now: task, files, open threads
//   report [--files n]   every open session by name and status, who waits on a human, shared paths
//   who "<job or path>"  which open session is the right one for a job
//   role "<text>"        set this session's role (what it is for)
//   job add "<title>" --to <name|role|anyone> [--detail ..] [--file p]   ask another session for work
//   job take|done|decline|note <id> ["<note>"]   move a job along
//   jobs [--all]         jobs for this session and jobs it asked for (--all: the whole queue)
//   notice "<text>" [--to <role|name|all>]   post to the notice board; notices: read it
//   land <worktree> [files...] [--dry-run] [--force]   bring a worktree's changes onto main by 3-way merge
//   decide "<| row |>" [--message ..]   log a decision in docs/DECISIONS.md and commit that row alone
//   threads [--new|--tracked|--all] [--backfill]   open threads sessions left (for the systems agent)
//   thread track|done|drop <id> "<note>"   sort one
//   overview [--html <file>]   who is working on what (also written each turn to .claude/cairn/overview.json)
//   checkpoints [n] [topic]  checkpoint bodies, newest first or ranked by topic (default 3)
//   checkpoint        distill now (used detached by the Stop hook; also manual)
//   remember "<one sentence>" [--ref <path>]...   record a learning
//   learnings [query] learnings ranked over text AND cited paths
//   verify <key>      re-baseline a learning's refs (clears the stale flag)
//   forget <key>      retire a learning for good (--reason "<why>")
//   mine <ref>        extract learnings from a commit (post-commit hook entry)
//   gc [--compact]    housekeeping; --compact folds duplicates in place
//   doctor            environment + installation checks
//   graph <build|status|neighbors|impact|query|explain|path|areas|export|bench>   the repo's knowledge graph
//   hook <name>       run a Claude Code hook (what settings.json calls in global mode)
//   test <name> [args]   ask the shared test queue for a result (config `tests`)
//   version           the installed cairn-agent version
//   selftest          fixture-driven end-to-end test (CAIRN_DISTILL=mechanical)

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderLearning } from "../lib/context.mjs";
import { claudeBin, mineCommit } from "../lib/distill.mjs";
import {
  chainPostCommit,
  ensureConfig,
  ensureGitignore,
  postCommitChained,
} from "../lib/install.mjs";
import { gc, writeCheckpoint } from "../lib/lifecycle.mjs";
import { renderLiveBoard } from "../lib/activity.mjs";
import { isStoreOnlyChange, queryTerms, scoreCheckpoints, scoreLearnings } from "../lib/rank.mjs";
import {
  addLearning,
  churnRates,
  configuredKey,
  dataDir,
  derivedKey,
  log,
  readCheckpoints,
  readLearnings,
  recallable,
  repoBranch,
  repoKey,
  repoRoot,
  retireLearning,
  verifyLearning,
} from "../lib/store.mjs";
import { HOOK_MARKERS, LEGACY_ALLOW, allowRule, cli, hookCommand, installedIn, version } from "../lib/cmd.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// --- init ---------------------------------------------------------------
// Hooks run from the project's own copy when cairn-agent is a devDependency (version pinned with the repo), else
// from the global `cairn` command (works in repos with no Node tooling). `--local` / `--global` force a mode.
const HOOK_SPECS = {
  SessionStart: [{ matcher: "startup|clear|compact", hook: "session_start", timeout: 10 }],
  UserPromptSubmit: [{ hook: "user_prompt_submit", timeout: 10 }],
  // Edits, messages and question boxes: holds the first edit of a file another open session edited in the last
  // hour (once), message rules, leave-to-carry-on questions.
  PreToolUse: [
    { matcher: "Edit|Write|MultiEdit|NotebookEdit|SendMessage|AskUserQuestion", hook: "pre_tool_use", timeout: 10 },
    // Heavy shell commands (headless browsers, long test runs, builds) wait here for a machine-wide slot.
    { matcher: "Bash|PowerShell", hook: "pre_tool_use", timeout: 600 },
  ],
  // Records the file on the live board; warns on overlap and coupling with other live sessions.
  PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|SendMessage", hook: "post_tool_use", timeout: 10 }],
  Stop: [{ hook: "stop", timeout: 10 }],
  PreCompact: [{ matcher: "manual|auto", hook: "pre_compact", timeout: 90 }],
};
export function hooksBlock(mode) {
  const out = {};
  for (const [event, specs] of Object.entries(HOOK_SPECS))
    out[event] = specs.map((s) => ({
      ...(s.matcher ? { matcher: s.matcher } : {}),
      hooks: [{ type: "command", command: hookCommand(mode, s.hook), timeout: s.timeout }],
    }));
  return out;
}
const isCairnEntry = (entry) => HOOK_MARKERS.some((m) => JSON.stringify(entry).includes(m));

function onPath(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function init() {
  const root = repoRoot(cwd);
  const changes = [];
  const mode = flag("local") ? "local" : flag("global") ? "global" : installedIn(root) ? "local" : "global";

  dataDir(cwd); // creates .claude/cairn/{,state,log}

  const gi = join(root, ".gitignore");
  const giText = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!giText.includes("!.claude/cairn/config.json"))
    changes.push(["append .gitignore", "scope cairn store, share learnings.jsonl + config.json"]);
  if (!configuredKey(cwd))
    changes.push(["cairn/config.json", `pin repo_key ${derivedKey(cwd)} (clone-URL independent)`]);

  const settingsPath = join(root, ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks ??= {};
  for (const [event, entries] of Object.entries(hooksBlock(mode))) {
    const current = settings.hooks[event] || [];
    const mine = current.filter(isCairnEntry);
    if (JSON.stringify(mine) === JSON.stringify(entries)) continue;
    // Replace Cairn's own entries (an older copy, the other mode), keep everyone else's.
    settings.hooks[event] = [...current.filter((e) => !isCairnEntry(e)), ...entries];
    changes.push([`hooks.${event}`, mine.length ? `cairn hook updated (${mode})` : `cairn hook registered (${mode})`]);
  }
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  const rule = allowRule(mode);
  const stale = settings.permissions.allow.filter((r) => r === LEGACY_ALLOW || (r !== rule && (r === allowRule("local") || r === allowRule("global"))));
  if (stale.length) {
    settings.permissions.allow = settings.permissions.allow.filter((r) => !stale.includes(r));
    changes.push(["permissions.allow", `removed ${stale.join(", ")}`]);
  }
  if (!settings.permissions.allow.includes(rule)) {
    settings.permissions.allow.push(rule);
    changes.push(["permissions.allow", rule]);
  }

  if (!postCommitChained(cwd, mode)) changes.push(["git post-commit", `chain cairn mine (${mode})`]);

  if (mode === "global" && !onPath("cairn"))
    console.log("note: `cairn` is not on PATH. Install it with `npm i -g cairn-agent`, or add it to this project with `npm i -D cairn-agent` and re-run init.");

  if (!changes.length) {
    console.log(`cairn init: nothing to do (already installed, ${mode} mode)`);
    return;
  }
  console.log(`cairn init (${mode} mode${mode === "local" ? ": hooks run from node_modules/cairn-agent" : ": hooks run the global `cairn` command"}) will make these changes:`);
  for (const [what, detail] of changes) console.log(`  - ${what}: ${detail}`);
  if (!flag("yes")) {
    console.log("re-run with --yes to apply");
    return;
  }

  ensureGitignore(cwd);
  ensureConfig(cwd);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  chainPostCommit(cwd, mode);
  console.log(
    "cairn init: applied. Hooks take effect from the NEXT session (config is snapshotted at session start).",
  );
}

// --- commands -----------------------------------------------------------
const commands = {
  init,

  async status() {
    const cps = readCheckpoints(cwd).filter((c) => c.repo_key === repoKey(cwd));
    const rows = recallable(cwd);
    const stale = rows.filter((l) => l.stale).length;
    console.log(`repo_key: ${repoKey(cwd)}  branch: ${repoBranch(cwd)}`);
    console.log(
      `checkpoints: ${cps.length}  learnings: ${rows.length} distinct ` +
        `(${readLearnings(cwd).length} rows on disk, ${stale} flagged stale)`,
    );
    console.log(`store: ${dataDir(cwd)}`);
    const { graphLine } = await import("../lib/graph/doctor.mjs");
    console.log(graphLine(cwd));
  },

  live() {
    const board = renderLiveBoard(cwd, { exclude: opt("session") });
    console.log(board || "no other sessions active in the last 6 h");
  },

  async who() {
    const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!query) fail('usage: who "<what the job is about, or a path>"');
    const { renderWho } = await import("../lib/report.mjs");
    console.log(renderWho(cwd, query));
  },

  async role() {
    // Run from inside a session: Claude Code puts its id in the shell's environment.
    const sessionId = opt("as") || process.env.CLAUDE_CODE_SESSION_ID;
    const text = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--as").join(" ").trim();
    if (!sessionId) fail("no session: run this from inside a Claude Code session, or pass --as <session id>");
    if (!text) fail('usage: role "<what this session is for, e.g. water and sea>"');
    const { touch } = await import("../lib/activity.mjs");
    // A role is a few words: "character modeler: modular characters, …" keeps "character modeler".
    touch(cwd, sessionId, { role: text.toLowerCase().split(/[:,;.(]/)[0].trim().slice(0, 40) });
    console.log(`role set: ${text}`);
  },

  // job add "<title>" --to <name|role|anyone> [--detail "..."] [--file p]... | job take|done|decline|note <id> ["<note>"]
  async job() {
    const J = await import("../lib/jobs.mjs");
    const self = J.me(cwd, opt("as"));
    if (!self) fail("no session: run this from inside a Claude Code session, or pass --as <session id>");
    const [sub, ...rest] = args;
    const plain = [];
    const files = [];
    for (let i = 0; i < rest.length; i++) {
      if (["--to", "--detail", "--as"].includes(rest[i])) i++;
      else if (rest[i] === "--file") files.push(rest[++i]);
      else plain.push(rest[i]);
    }
    const by = { id: self.id, name: self.name };
    if (sub === "add") {
      const title = plain.join(" ").trim();
      if (!title || !opt("to")) fail('usage: job add "<what needs doing>" --to <name|role|anyone> [--detail "..."] [--file <path>]...');
      const job = J.addJob(cwd, { from: by, to: opt("to"), title, detail: opt("detail") || "", files });
      console.log(`job #${job.id} added for ${job.to}.`);
      const line = `  Job #${job.id} for you from ${self.name}: ${title} (${cli()} jobs)`;
      const r = job.to === "anyone" ? null : J.recipientFor(cwd, job.to);
      if (r) console.log(`Now wake ${r.name}${r.role ? ` (role: ${r.role})` : ""}: SendMessage to "${r.name}" with the first line\n${line}`);
      else
        console.log(
          (job.to === "anyone" ? "Wake the session(s) you mean" : `No open session has "${job.to}" as its name or role yet; it will see the job when one does. Or wake one yourself`) +
            ` with a SendMessage whose first line is\n${line}`,
        );
      return;
    }
    const [id, ...noteWords] = plain;
    // release: hand a taken job back to the queue, unfinished (you were moved to other work)
    const ctl = { take: "take", done: "done", decline: "decline", note: "note", release: "release" }[sub];
    if (!ctl || !id) fail("usage: job add|take|done|decline|note|release …");
    const note = noteWords.join(" ").trim();
    if ((ctl === "decline" || ctl === "release") && !note) fail(`say why: job ${ctl} <id> "<reason>"`);
    const job = J.updateJob(cwd, id, ctl, by, note);
    if (!job) fail(`no job #${id}`);
    console.log(J.renderJob(job));
    if (ctl === "done" || ctl === "decline")
      console.log(`Tell ${job.from?.name}: SendMessage with a first line like "Job #${job.id} ${ctl === "done" ? "done" : "declined"}: …"`);
  },

  // jobs [--all]: jobs for this session (addressed to its name or role, or taken by it) and jobs it asked for
  async jobs() {
    const J = await import("../lib/jobs.mjs");
    const self = J.me(cwd, opt("as"));
    if (flag("all") || !self) {
      console.log(J.renderQueue(cwd));
      return;
    }
    const mine = J.jobsFor(cwd, self);
    const asked = J.readJobs(cwd).filter((j) => j.from?.id === self.id && !["done", "declined"].includes(j.status));
    console.log(mine.length ? `For you (${self.name}${self.role ? `, ${self.role}` : ""}):` : "No open jobs for you.");
    for (const j of mine) console.log(`- ${J.renderJob(j)}`);
    if (asked.length) console.log("You asked for:");
    for (const j of asked) console.log(`- ${J.renderJob(j)}`);
  },

  // notice "<text>" [--to <role|name|all>]: post to the notice board (every open session sees it once)
  async notice() {
    const J = await import("../lib/jobs.mjs");
    const self = J.me(cwd, opt("as"));
    if (!self) fail("no session: run this from inside a Claude Code session, or pass --as <session id>");
    const text = args.filter((a, i) => !a.startsWith("--") && !["--to", "--as"].includes(args[i - 1])).join(" ").trim();
    if (!text) fail('usage: notice "<what every session should know>" [--to <role|name|all>]');
    if (text.length > J.NOTICE_MAX)
      fail(`keep a notice under ${J.NOTICE_MAX} characters: put the detail in a doc and link to it (docs/WORKING.md section 3)`);
    const n = J.addNotice(cwd, { from: { id: self.id, name: self.name }, to: opt("to") || "all", text });
    console.log(`notice #${n.id} posted to ${n.to}; each open session sees it once, on its next prompt or edit.`);
  },

  // land <worktree> [files...] [--dry-run] [--force]: a worker's changes onto main by a three-way merge per file,
  // never by copying (lib/land.mjs; docs/WORKING.md, "Landing work from a worktree").
  async land() {
    const pos = args.filter((a) => !a.startsWith("--"));
    if (!pos.length) fail("usage: land <worktree> [files...] [--dry-run] [--force]");
    const { land } = await import("../lib/land.mjs");
    const r = land(cwd, pos[0], {
      files: pos.slice(1),
      dryRun: flag("dry-run"),
      force: flag("force"),
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
    });
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  },

  // overview [--html <file>]: who is working on what, for Robin; --html writes the page the commander publishes.
  async overview() {
    const { renderOverviewHtml, writeOverview } = await import("../lib/overview.mjs");
    const data = writeOverview(cwd);
    const out = flag("html") ? (opt("html") && !opt("html").startsWith("--") ? opt("html") : join(dataDir(cwd), "overview.html")) : null;
    if (out) writeFileSync(out, renderOverviewHtml(data));
    for (const s of data.sessions)
      console.log(`- ${s.name} (${s.role || "no role"}, ${s.status}, ${s.jobs.length} job(s)): ${s.task || "task not known"}`);
    console.log(`${data.unheld.length} job(s) nobody holds; ${data.noReply.length} message(s) waiting for a reply${out ? `; page written to ${out}` : ""}`);
  },

  // threads [--new|--tracked|--all] [--backfill [--since YYYY-MM-DD]]: open threads sessions left (lib/threads.mjs).
  async threads() {
    const T = await import("../lib/threads.mjs");
    if (flag("backfill")) {
      const { readJobs } = await import("../lib/jobs.mjs");
      const r = T.backfill(cwd, { since: opt("since") || "2026-10-13", jobs: readJobs(cwd) });
      console.log(`backfill: ${r.found} thread line(s) found, ${r.added} new after folding duplicates, ${r.closed} closed (their jobs are done), ${r.open} left to sort`);
      return;
    }
    const want = flag("all") ? null : flag("tracked") ? "tracked" : "new";
    const rows = T.readThreads(cwd).filter((t) => !want || t.status === want);
    for (const t of rows)
      console.log(`- #${t.id} ${t.status} [${t.name || t.session}${t.role ? ", " + t.role : ""}, ${String(t.at).slice(0, 10)}, ${t.source}${t.mentions > 1 ? `, said ${t.mentions}x` : ""}] ${t.text}${t.notes.length ? `\n    note: ${t.notes[t.notes.length - 1]}` : ""}`);
    console.log(`${rows.length} thread(s)${want ? ` ${want}` : ""}`);
  },

  // thread track|done|drop <id> "<note>": the systems agent sorts a thread.
  async thread() {
    const [verb, id, ...rest] = args.filter((a) => !a.startsWith("--"));
    if (!["track", "done", "drop", "reopen"].includes(verb) || !id) fail('usage: thread track|done|drop|reopen <id> "<note>"');
    const T = await import("../lib/threads.mjs");
    const { me } = await import("../lib/jobs.mjs");
    const t = T.setThread(cwd, id.replace(/^#/, ""), verb, me(cwd)?.name || "manual", rest.join(" "));
    if (!t) fail(`no thread #${id}`);
    console.log(`#${t.id} ${t.status}: ${t.text}`);
  },

  // decide "<| row |>" [--message "<commit message>"] [--file docs/DECISIONS.md]: log a decision, commit that row alone.
  async decide() {
    const row = args.filter((a, i) => !a.startsWith("--") && !["--message", "--file"].includes(args[i - 1]))[0];
    if (!row) fail('usage: decide "| Robin (date): **the decision** | where it is recorded |" [--message "<commit message>"]');
    const { decide } = await import("../lib/decide.mjs");
    const r = decide(cwd, row, { file: opt("file") || "docs/DECISIONS.md", message: opt("message") });
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  },

  async notices() {
    const J = await import("../lib/jobs.mjs");
    const rows = J.readNotices(cwd);
    console.log(rows.length ? rows.map((n) => J.renderNotice(n)).join("\n") : "no notices in the last 2 days");
  },

  // slots: heavy runs on the machine now, by kind, against their limits (lib/heavy.mjs)
  async slots() {
    const H = await import("../lib/heavy.mjs");
    const now = H.running({ fresh: true });
    if (!now) return console.log("can't read the process list");
    for (const k of Object.keys(H.LIMITS)) console.log(`${k.padEnd(8)} ${now[k]} running, limit ${H.limit(k)}${now[k] >= H.limit(k) ? "  (full: new runs wait)" : ""}`);
    const Q = await import("../lib/testq.mjs");
    const q = Q.snapshot(cwd);
    if (q.length) console.log("test queue:");
    for (const { key, running: r, last } of q)
      console.log(`  ${key.padEnd(16)} ${r ? `running since ${new Date(r.startedAt).toTimeString().slice(0, 8)} (${r.by})` : "idle"}${last ? `; last ${last.exit === 0 ? "passed" : "FAILED"} at ${new Date(last.finishedAt).toTimeString().slice(0, 8)}` : ""}`);
  },

  async report() {
    const { renderReport } = await import("../lib/report.mjs");
    console.log(renderReport(cwd, { files: Number(opt("files") || 8) }));
    const { renderQueue } = await import("../lib/jobs.mjs");
    console.log("\n" + renderQueue(cwd));
  },

  checkpoints() {
    const n = Number(args.find((a) => /^\d+$/.test(a)) || 3);
    const query = args.filter((a) => !/^\d+$/.test(a)).join(" ");
    const all = readCheckpoints(cwd).filter((c) => c.repo_key === repoKey(cwd));
    // With a topic, rank by relevance (files named, words in task/body);
    // without one, newest first.
    const cps = query
      ? scoreCheckpoints(all, {
          terms: queryTerms(query),
          files: query.split(/\s+/).filter((w) => /\.\w+$/.test(w)),
        })
          .filter((c) => c.relevance > 0)
          .slice(0, n)
      : all.slice(-n).reverse();
    if (!cps.length) return console.log(query ? `no checkpoints match "${query}"` : "no checkpoints stored");
    for (const c of cps) {
      console.log(
        `--- ${c.created_at}  ${c.trigger}/${c.engine}  branch ${c.branch}\n${c.body_md}\n`,
      );
    }
  },

  checkpoint() {
    // The Stop hook runs this detached with stdio ignored, so an exception here
    // used to vanish without trace — leaving "no checkpoints exist" with no way
    // to tell whether the hook never fired or the distiller died. Log both ends.
    const trigger = opt("trigger") || "manual";
    log(cwd, `checkpoint: start (${trigger})`);
    try {
      const row = writeCheckpoint(cwd, {
        sessionId: opt("session") || "manual",
        transcriptPath: opt("transcript") || "",
        trigger,
      });
      if (!row) log(cwd, `checkpoint: empty segment (${trigger}), nothing written`);
      console.log(row ? `checkpoint written (${row.engine})` : "empty segment: no checkpoint");
    } catch (err) {
      log(cwd, `checkpoint: FAILED (${trigger}): ${err?.stack || err}`);
      fail(`checkpoint failed: ${err?.message || err}`);
    }
  },

  remember() {
    // Join positionals rather than picking the first: an unquoted sentence
    // arrives as many argv entries and used to be silently truncated to one word.
    const refs = [];
    const words = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--ref") {
        const r = args[++i];
        if (!r) fail("--ref needs a path");
        refs.push(r);
      } else if (!args[i].startsWith("--")) words.push(args[i]);
    }
    const text = words.join(" ").trim();
    if (!text) fail('usage: remember "<one sentence>" [--ref <path>[#Symbol]]...');
    if (text.length > 200) fail("keep it to one sentence (<= 200 chars)");
    for (const r of refs) if (!existsSync(join(repoRoot(cwd), r.split("#")[0]))) fail(`ref does not exist: ${r}`);
    const row = addLearning(cwd, { text, source: "manual", refs });
    if (row.duplicate) {
      console.log(`already known (${row.of.key}): ${row.of.text}`);
      return;
    }
    console.log(`learning #${row.id} recorded as ${row.key} (${refs.length} ref(s))`);
  },

  learnings() {
    const terms = args
      .filter((a) => !a.startsWith("--"))
      .join(" ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const all = recallable(cwd);
    let rows = all;
    if (terms.length) {
      // Ranks over cited paths as well as text, so `learnings jobBoard` finds
      // the learnings ABOUT src/sim/jobs/jobBoard.ts, not only those that
      // happen to spell it in the sentence.
      rows = scoreLearnings(all, { terms, files: terms, churn: churnRates(cwd) }).filter(
        (l) => l.relevance > 0,
      );
    }
    if (!rows.length) return console.log("no matching learnings");
    for (const l of rows.slice(0, Number(opt("limit") || 10))) {
      console.log(`${l.key}  ${renderLearning(l).slice(2)}`);
      if (l.refs?.length) console.log(`         refs: ${l.refs.join(", ")}`);
    }
    if (rows.length > 10) console.log(`(${rows.length - 10} more; --limit N for more)`);
  },

  verify() {
    const key = args.find((a) => !a.startsWith("--"));
    if (!key) fail("usage: verify <key>");
    const row = verifyLearning(cwd, key);
    console.log(row ? `re-verified ${row.key}: ${row.text}` : `no learning with key ${key}`);
  },

  forget() {
    const key = args.find((a) => !a.startsWith("--"));
    if (!key) fail('usage: forget <key> [--reason "<why>"]');
    const row = retireLearning(cwd, key, opt("reason"));
    console.log(row ? `retired ${row.key}: ${row.text}` : `no learning with key ${key}`);
  },

  async mine() {
    const ref = args.find((a) => !a.startsWith("--")) || "HEAD";
    if (flag("detach")) {
      spawn(process.execPath, [join(HERE, "cairn.mjs"), "mine", ref], {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      // A commit changed the code: bring the graph up to date too (no-op when a worker is already running).
      const { maybeSpawn } = await import("../lib/graph/lock.mjs");
      maybeSpawn(cwd, "update", 0);
      return;
    }
    const git = (a) =>
      execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 8 << 20, windowsHide: true });
    const hash = git(["rev-parse", "--short", ref]).trim();
    // Never mine a commit that only touches the store itself: the diff is the
    // learnings file, so the miner reads back stored facts and re-emits them as
    // "new" ones — a feedback loop that manufactures near-duplicates.
    const touched = git(["show", "--name-only", "--format=", ref]).split("\n");
    if (isStoreOnlyChange(touched)) {
      console.log(`skipped ${hash}: cairn store only`);
      return;
    }
    const message = git(["log", "-1", "--format=%B", ref]).trim();
    const diff = git(["show", ref, "--format=", "--unified=1"]);
    const { items, shards, totalShards, files, sampledFiles } = mineCommit(message, diff);
    let n = 0;
    let dup = 0;
    for (const item of items) {
      const refs = (item.refs || [])
        .map((r) => r.replace(/:\d+(-\d+)?$/, "")) // models sometimes emit path:line
        .filter((r) => existsSync(join(repoRoot(cwd), r.split("#")[0])));
      try {
        if (addLearning(cwd, { text: item.text, source: `commit:${hash}`, refs }).duplicate) dup++;
        else n++;
      } catch (err) {
        log(cwd, `mine ${hash}: ${err?.message || err}`);
      }
    }
    // Say when the commit was sampled rather than read whole — a bare count
    // reads as full coverage and hides the files the miner never saw.
    const coverage =
      shards < totalShards
        ? `, sampled ${shards}/${totalShards} shards (${sampledFiles}/${files} files)`
        : "";
    console.log(
      `mined ${n} learning(s) from ${hash}${dup ? ` (${dup} already known)` : ""}${coverage}`,
    );
  },

  gc() {
    console.log(gc(cwd, { compact: flag("compact") }) ? "gc: store updated" : "gc: nothing to do");
  },

  async doctor() {
    const ok = (label, pass, note = "") =>
      console.log(`${pass ? " ok " : "FAIL"}  ${label}${note ? ` — ${note}` : ""}`);
    ok(
      "store writable",
      (() => {
        try {
          dataDir(cwd);
          return true;
        } catch {
          return false;
        }
      })(),
    );
    const key = repoKey(cwd);
    ok("repo_key", true, `${key}${configuredKey(cwd) ? " (from config.json)" : " (derived)"}`);
    // The failure this catches: learnings.jsonl is committed and shared, but the
    // key used to come from the origin URL, so a fork/mirror/proxied clone read
    // an empty store while 74 rows sat in the file it had just cloned.
    if (!configuredKey(cwd)) {
      ok(
        "repo_key pinned",
        false,
        `derived from origin (${derivedKey(cwd)}); run \`cairn init --yes\` to pin it in config.json`,
      );
    }
    const foreign = new Set(
      readLearnings(cwd)
        .filter((l) => l.repo_key && l.repo_key !== key)
        .map((l) => l.repo_key),
    );
    // Informational, not a failure: repo_key is provenance now, not a filter,
    // so rows tagged by another clone's URL are still fully recalled.
    ok(
      "learnings repo_key provenance",
      true,
      foreign.size ? `also tagged ${[...foreign].join(", ")} — all recalled` : "single key",
    );
    ok("branch", true, repoBranch(cwd));
    const bin = claudeBin();
    ok("claude CLI (distiller engine)", !!bin, bin || "will fall back to api/mechanical");
    const sp = join(repoRoot(cwd), ".claude", "settings.json");
    const s = existsSync(sp) ? readFileSync(sp, "utf8") : "";
    const local = s.includes("cairn-agent/hooks/");
    const mode = local ? "local" : "global";
    ok("hooks registered", HOOK_MARKERS.some((m) => s.includes(m)), s.includes("scripts/cairn/hooks") ? "old scripts/cairn copy: run `cairn init --yes` to move to the package" : `${mode} mode`);
    ok("CLI allowlisted", s.includes(allowRule(mode)));
    ok("cairn-agent version", true, `${version()} (${cli() === "cairn" ? "global" : "this project's copy"})`);
    if (!local) ok("`cairn` on PATH", onPath("cairn"), "hooks call it; `npm i -g cairn-agent`");
    else ok("installed in node_modules", installedIn(repoRoot(cwd)), "`npm i -D cairn-agent`");
    const pcOk = postCommitChained(cwd, mode);
    ok("post-commit chained", pcOk, pcOk ? "" : "self-heals at next session start");
    const { graphChecks } = await import("../lib/graph/doctor.mjs");
    for (const [label, pass, note] of graphChecks(cwd)) ok(label, pass, note);
  },

  // hook <name>: run one of Cairn's Claude Code hooks (what settings.json calls in global mode).
  async hook() {
    const name = String(args[0] || "").replace(/[^a-z_]/g, "");
    if (!["session_start", "user_prompt_submit", "pre_tool_use", "post_tool_use", "stop", "pre_compact"].includes(name))
      fail("usage: hook <session_start|user_prompt_submit|pre_tool_use|post_tool_use|stop|pre_compact>");
    await import(`../hooks/${name}.mjs`); // the hook reads stdin and exits on its own
  },

  // test <name> [args]: ask the shared test queue for a result (config `tests`).
  async test() {
    await import("../lib/testcmd.mjs");
  },

  version() {
    console.log(version());
  },

  async graph() {
    const { graphCli } = await import("../lib/graph/cli.mjs");
    await graphCli(cwd, args, { opt, flag });
  },

  async selftest() {
    const { selftest } = await import("../lib/selftest.mjs");
    process.exit(await selftest());
  },
};

if (!cmd || !commands[cmd]) {
  console.log(
    "usage: cairn.mjs <init|status|live|slots|report|who|role|job|jobs|notice|notices|land|overview|threads|thread|decide|checkpoints|checkpoint|remember|learnings|verify|forget|mine|gc|doctor|graph|hook|test|version|selftest>",
  );
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
