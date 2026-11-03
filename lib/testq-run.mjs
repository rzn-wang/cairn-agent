#!/usr/bin/env node
// One run of a queued test (lib/testq.mjs), started detached: runs the command with its output to the run's log,
// then records the exit code in the run file, so every session waiting on it gets the result even if the one that
// started it has gone. Usage: node testq-run.mjs <run.json> <repo root>

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";

const [runFile, root] = process.argv.slice(2);
const run = JSON.parse(readFileSync(runFile, "utf8"));
const fd = openSync(run.log, "w");
const args = (run.args || []).map((a) => (/^[\w.,:=/@-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
const child = spawn(`${run.command}${args ? ` ${args}` : ""}`, {
  cwd: root,
  shell: true,
  stdio: ["ignore", fd, fd],
  windowsHide: true,
  env: { ...process.env, CAIRN_TESTQ_CHILD: "1" },
});
// A heartbeat in the run file: the queue counts the run as going only while it is fresh, so a process number that
// Windows reuses after this runner dies is never taken for the run (2026-10-22: a killed runner's pid went to an
// unrelated sleep.exe and the queue kept waiting on it).
const beat = () => {
  try {
    const now = JSON.parse(readFileSync(runFile, "utf8"));
    if (!Number.isFinite(now.exit)) writeFileSync(runFile, JSON.stringify({ ...now, beat: Date.now() }));
  } catch {
    /* the queue may be writing it; next beat */
  }
};
beat();
const beating = setInterval(beat, 30000);
child.on("exit", (code) => {
  clearInterval(beating);
  closeSync(fd);
  const now = JSON.parse(readFileSync(runFile, "utf8"));
  writeFileSync(runFile, JSON.stringify({ ...now, exit: code ?? 1, finishedAt: Date.now() }));
});
