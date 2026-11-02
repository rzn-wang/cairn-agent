// One graph writer at a time, machine-wide for this repo. A lock file with a heartbeat, not a process number:
// Windows hands a dead process's number to the next one (the test queue learned this on 2026-10-22).
// `maybeSpawn` is what hooks call: it costs a couple of stat calls and never opens the database.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enabled, graphPaths, loadSqlite } from "./db.mjs";

const BEAT_MS = 10000;
const STALE_MS = 120000;

export function readLock(cwd) {
  try {
    return JSON.parse(readFileSync(graphPaths(cwd).lock, "utf8"));
  } catch {
    return null;
  }
}
export const lockFresh = (l, now = Date.now()) => !!l && now - (l.beat || l.at || 0) < STALE_MS;

// Returns a release function, or null when another writer holds a fresh lock.
export function acquire(cwd, mode = "update") {
  const { dir, lock } = graphPaths(cwd);
  mkdirSync(dir, { recursive: true });
  const body = () => JSON.stringify({ pid: process.pid, host: hostname(), mode, at, beat: Date.now() });
  const at = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, body());
      closeSync(fd);
      const timer = setInterval(() => {
        try {
          const cur = readLock(cwd);
          if (cur && cur.pid === process.pid && cur.at === at) writeFileSync(lock, body());
        } catch {
          /* a missed beat only risks a steal after two minutes */
        }
      }, BEAT_MS);
      timer.unref();
      return () => {
        clearInterval(timer);
        const cur = readLock(cwd);
        if (cur && cur.pid === process.pid && cur.at === at) rmSync(lock, { force: true });
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (lockFresh(readLock(cwd))) return null;
      rmSync(lock, { force: true }); // stale: its writer died; take it
    }
  }
  return null;
}

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "cairn.mjs");

export function spawnWorker(cwd, mode = "update") {
  const child = spawn(process.execPath, [CLI, "graph", "update", "--mode", mode, "--quiet"], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID || "" },
  });
  child.unref();
  return child.pid;
}

// Start a detached update unless one ran within `minIntervalMs` or a writer is busy. Cheap enough for any hook.
export function maybeSpawn(cwd, mode = "update", minIntervalMs = 120000) {
  try {
    if (!enabled() || process.env.CAIRN_GRAPH_AUTO === "0") return false;
    const { stamp, dir } = graphPaths(cwd);
    if (minIntervalMs > 0) {
      try {
        if (Date.now() - statSync(stamp).mtimeMs < minIntervalMs) return false;
      } catch {
        /* never ran */
      }
    }
    if (lockFresh(readLock(cwd))) return false;
    if (!loadSqlite()) return false;
    mkdirSync(dir, { recursive: true });
    // Touch the stamp first, so a burst of hooks spawns one worker, not ten.
    if (existsSync(stamp)) utimesSync(stamp, new Date(), new Date());
    else writeFileSync(stamp, "");
    spawnWorker(cwd, mode);
    return true;
  } catch {
    return false;
  }
}
