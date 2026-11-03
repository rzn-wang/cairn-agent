// The shared test queue (Robin, 2026-10-07: "a queue for tests, and if the queue is smart, tests are combined for
// multiple agents"). The project's test scripts (config `tests`) come here instead of running directly.
//
// One run of each test (and its arguments) at a time, plus at most one next run that everyone asking meanwhile
// shares. A run is good for a request when it started after the request was made (it sees the requester's files),
// or when no source file has changed since it started (finished runs on an unchanged tree are reused outright).
// The run itself is a detached process (testq-run.mjs) that records its exit, so a requester whose command times
// out loses nothing: asking again finds the same run. Logs live in .claude/cairn/tests/.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { addNotice } from "./jobs.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { limit, running, tryClaim } from "./heavy.mjs";
import { dataDir, repoRoot } from "./store.mjs";
import { projectConfig } from "./config.mjs";

// What to run comes from the project config (lib/config.mjs: `tests`, `source`, `skip`), e.g.
//   "tests": { "simtest": { "kind": "simtest", "command": "node tools/simtest.mjs" },
//              "build": { "kind": "build", "command": "tsc --noEmit && vite build" } },
//   "source": ["src", "tools", "package.json"]
const cfg = projectConfig();
export const TESTS = { ...cfg.tests };
// For the selftest only: a 3-second stand-in, so the queue can be tested without running the project's tests.
if (process.env.CAIRN_TESTQ_DUMMY)
  TESTS.dummy = { kind: "build", command: `node -e "setTimeout(() => console.log('dummy ran'), 3000)"` };
const KEEP = 12; // runs kept per test
const SOURCE = cfg.source || [];
const SKIP = new Set(cfg.skip || []);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// Newest modification time of any source file, or of anything under the given roots.
// No `source` configured: nothing proves an old run still fits, so only runs started after the request count.
export function newestChange(root) {
  if (!SOURCE.length) return Infinity;
  let newest = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) if (!SKIP.has(f)) walk(join(p, f));
    } else if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const s of SOURCE) walk(join(root, s));
  return newest;
}

function keyDir(cwd, name, args) {
  const key = [name, ...args].join(" ");
  const dir = join(dataDir(cwd), "tests", `${name}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return { key, dir };
}

export function runsIn(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      r.file = join(dir, f);
      out.push(r);
    } catch {
      /* being written */
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

// A run's state: "done" (finished, has an exit code), "running", or "lost" (its runner ended without recording).
// A runner beats every 30 s (testq-run.mjs); a run is going while its beat is fresh. Runs started before the beat
// existed fall back to their process number, which Windows can reuse once the runner is gone.
const BEAT_STALE = 2 * 60000;
export function stateOf(r, now = Date.now()) {
  if (Number.isFinite(r.exit)) return "done";
  if (r.beat) return now - r.beat <= BEAT_STALE ? "running" : "lost";
  return r.pid && alive(r.pid) ? "running" : "lost";
}

function prune(dir) {
  const runs = runsIn(dir).filter((r) => stateOf(r) !== "running");
  for (const r of runs.slice(0, Math.max(0, runs.length - KEEP))) {
    rmSync(r.file, { force: true });
    rmSync(r.log, { force: true });
  }
}

// The watchdog (Robin, 2026-10-21): a run whose log has been silent this long is hung. A full simtest takes about
// 55 minutes but writes a line every few seconds; a run stuck in a loop held the queue for two hours that night.
export const HUNG_MS = 20 * 60000;
function silentMs(r, now = Date.now()) {
  try {
    return now - statSync(r.log).mtimeMs;
  } catch {
    return now - r.startedAt;
  }
}
function killTree(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else
    try {
      process.kill(-pid, "SIGKILL"); // the runner is detached: its own process group
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
}
// Records each hung run as finished (exit 124, hung) before ending its process tree, so its runner can't write over
// the record, and tells the session that started it. Returns the runs it stopped.
export function reapHung(cwd, dir, { now = Date.now(), hungMs = HUNG_MS } = {}) {
  const reaped = [];
  for (const r of runsIn(dir)) {
    if (stateOf(r) !== "running" || silentMs(r, now) < hungMs) continue;
    const { file, ...rec } = r;
    const silent = Math.round(silentMs(r, now) / 60000);
    writeFileSync(file, JSON.stringify({ ...rec, exit: 124, hung: true, finishedAt: now }));
    // Only a fresh heartbeat proves the process number is still this run's runner; otherwise just let the run go.
    if (r.beat) killTree(r.pid);
    try {
      addNotice(cwd, {
        from: "cairn",
        to: r.by,
        text:
          `Cairn stopped the ${r.key} run you started at ${new Date(r.startedAt).toTimeString().slice(0, 5)}: its output was silent for ` +
          `${silent} min, so it was hung and held the test queue for everyone (Cairn's watchdog). The log's last lines show ` +
          `where it stuck: ${r.log}. Uncommitted work in the shared tree runs in everyone's tests; develop slow steps in a worktree.`,
      });
    } catch {
      /* the notice is a courtesy; the queue must move on */
    }
    reaped.push(r);
  }
  return reaped;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "testq-run.mjs");

// Request a test result. Resolves to { run, shared, waitedMs } once a good run has finished.
export async function request(cwd, name, args = [], { requester = "?", onWait = () => {} } = {}) {
  const spec = TESTS[name];
  if (!spec) throw new Error(`unknown test ${name}`);
  const root = repoRoot(cwd);
  const { key, dir } = keyDir(cwd, name, args);
  const asked = Date.now();
  const changed = newestChange(root);
  const lockPath = join(dir, "starter.lock");
  let told = "";
  for (;;) {
    reapHung(cwd, dir);
    const runs = runsIn(dir);
    // A run that started after we asked, or one that started after the tree last changed, is good for us.
    const good = runs.filter((r) => stateOf(r) !== "lost" && (r.startedAt >= asked || r.startedAt >= changed)).pop();
    if (good && stateOf(good) === "done")
      return { run: good, shared: good.by !== requester || good.startedAt < asked, waitedMs: Date.now() - asked };
    const active = runs.find((r) => stateOf(r) === "running");
    if (good) {
      if (told !== "good") onWait(`sharing a ${key} run already going (started by ${good.by})`);
      told = "good";
    } else if (active) {
      if (told !== "next") onWait(`a ${key} run is going (started before you asked); you'll share the next one`);
      told = "next";
    } else {
      if (!tryClaim(spec.kind)) {
        const now = running();
        if (told !== "slot") onWait(`waiting for a free ${spec.kind} slot (${now ? now[spec.kind] : "?"} running, limit ${limit(spec.kind)})`);
        told = "slot";
      } else if (startRun(dir, lockPath, { name, key, args, command: spec.command, root, requester })) {
        continue; // started: the next pass finds it as good
      }
    }
    await sleep(1500 + Math.floor(Math.random() * 1000));
  }
}

// Start a run if we win the starter lock (a lock older than 60 s is from a crashed starter and is cleared).
function startRun(dir, lockPath, { name, key, args, command, root, requester }) {
  try {
    if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 60000) rmSync(lockPath, { force: true });
    closeSync(openSync(lockPath, "wx"));
  } catch {
    return false; // someone else is starting one
  }
  try {
    if (runsIn(dir).some((r) => stateOf(r) === "running")) return false;
    const startedAt = Date.now();
    const base = join(dir, `run-${startedAt}`);
    const run = { name, key, args, command, startedAt, by: requester, log: `${base}.log`, pid: 0 };
    writeFileSync(`${base}.json`, JSON.stringify(run));
    const child = spawn(process.execPath, [RUNNER, `${base}.json`, root], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    run.pid = child.pid;
    writeFileSync(`${base}.json`, JSON.stringify(run));
    prune(dir);
    return true;
  } finally {
    rmSync(lockPath, { force: true });
  }
}

// What the queue holds now: per test, the running run and the last finished one.
export function snapshot(cwd) {
  const out = [];
  let dirs = [];
  try {
    dirs = readdirSync(join(dataDir(cwd), "tests"));
  } catch {
    return out;
  }
  for (const d of dirs) {
    const runs = runsIn(join(dataDir(cwd), "tests", d));
    if (!runs.length) continue;
    out.push({
      key: runs[runs.length - 1].key,
      running: runs.find((r) => stateOf(r) === "running") || null,
      last: [...runs].reverse().find((r) => stateOf(r) === "done") || null,
    });
  }
  return out;
}
