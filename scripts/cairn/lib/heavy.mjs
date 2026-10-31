// Heavy runs, rationed across every session (Robin, 2026-10-07: "my cpu has difficulty handling it"). On that day
// six headless browsers, four simtests and three shot tools ran at once and the 16-thread CPU sat at 100%.
//
// The PreToolUse hook (matcher Bash) classifies each command. A heavy one waits, inside the hook, until fewer than
// the limit of its kind are running on the machine; then it starts. Nothing is refused: a command only starts
// later. The count is taken from the live process list (wmic, or PowerShell when wmic is missing), so it needs no
// locks and can't go stale when a run crashes. Two commands can see the same free slot at once and both start; at
// worst the limit is exceeded by one.
//
// Kinds and default limits (env CAIRN_MAX_<KIND> overrides):
//   browser  headless Chrome launched by a tool (playtest, shot, look, any tools/**/*.mjs using puppeteer)   2
//   simtest  pnpm simtest / tools/simtest.mjs                                                                  2
//   blender  Blender kit and texture builds                                                                    1
//   build    pnpm build / vite build                                                                           1

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { freemem, tmpdir } from "node:os";
import { join } from "node:path";

export const LIMITS = { browser: 2, simtest: 2, blender: 1, build: 1 };
// A heavy run starts only with this much memory free (Robin, 2026-10-27: limit our testing instances). A full simtest
// holds about 7.5 GB at its peak; two of them beside ~40 Claude processes left 3.7 GB of 31 free.
export const MIN_FREE_GB = Number(process.env.CAIRN_MIN_FREE_GB || 6);
// A node run with a big heap is a test run whatever its script (tools/out/simone.mjs, ../some.mjs): it takes a slot.
const bigHeap = (cmd) => Number((/--max-old-space-size=(\d+)/.exec(cmd) || [])[1] || 0) >= 4096;
export const limit = (kind) => Number(process.env[`CAIRN_MAX_${kind.toUpperCase()}`] || LIMITS[kind]);

const scriptCache = new Map();
function launchesBrowser(root, rel) {
  if (!scriptCache.has(rel)) {
    let yes = false;
    try {
      const p = join(root, rel);
      yes = existsSync(p) && /["']puppeteer(?:-core)?["']/.test(readFileSync(p, "utf8")); // imported, not just mentioned
    } catch {
      /* unreadable: not heavy */
    }
    scriptCache.set(rel, yes);
  }
  return scriptCache.get(rel);
}

// The kind of heavy run a shell command starts, or null. Only the command's own text is read, plus the script it
// names (does it use puppeteer?), so it is cheap enough to run on every Bash call.
// `pnpm simtest`, `pnpm playtest` and `pnpm build` are not counted here: they go through the shared test queue
// (lib/testq.mjs), which runs one at a time and shares each run among the sessions waiting for it. A script is
// heavy when it is run (`node …tools/x.mjs`), never when it is merely named (grep, sed, cat).
const NODE_RUN = /\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*["']?((?:[A-Za-z]:)?[\w./\\:-]*tools[\\/][\w./\\-]+\.mjs)/g;

// The command without what it only quotes: heredoc bodies (commit messages, scripts fed to node) and '…' or "…"
// strings (node -e code, grep patterns), so a command that mentions `vite build` or a tool isn't taken for running it.
export function unquoted(command) {
  const lines = String(command || "").split("\n");
  const out = [];
  let end = null;
  for (const line of lines) {
    if (end) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*['"]?(\w+)['"]?/.exec(line);
    if (m) end = m[1];
  }
  return out
    .join("\n")
    .replace(/\bnode\s+(["'])([^"'\n]+\.m?js)\1/g, "node $2") // a quoted script path is still run
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

export function classify(command, root) {
  // `node --check x.mjs` / `node -c` only parse the file: never heavy.
  const c = unquoted(command).replace(/nodes+(?:--check|-c)s+S+/g, "");
  if (/\bpnpm\s+(-s\s+)?(build:kit|build:folk|preview:kit|paint:[\w-]+)\b/.test(c)) return "blender";
  if (/\bpnpm\s+(-s\s+)?shot\b/.test(c)) return "browser";
  if (/(?:^|&&|;|\|\||\bnpx\s+|\bpnpm\s+(?:exec\s+)?)\s*vite\s+build\b/.test(c)) return "build"; // run, not quoted
  if (/\bnode\b/.test(c) && bigHeap(c)) return "simtest";
  for (const m of c.matchAll(NODE_RUN)) {
    const rel = m[1].replace(/\\/g, "/").replace(/^.*?(tools\/)/, "$1");
    if (rel === "tools/simtest.mjs") return "simtest";
    if (rel === "tools/blender/run.mjs") return "blender";
    if (launchesBrowser(root, rel)) return "browser";
  }
  // One-off probes anywhere (a session's scratch folder, tools/out): heavy when the script launches a browser.
  for (const m of c.matchAll(/\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*((?:[A-Za-z]:|\/)?[^\s;&|'"<>]+\.(?:mjs|cjs|js))\b/g)) {
    const p = m[1].replace(/^\/([a-z])\//i, "$1:/"); // Git Bash /c/Users/… → c:/Users/…
    const abs = /^[A-Za-z]:|^\//.test(p) ? p : join(root, p);
    if (launchesBrowser("", abs)) return "browser";
  }
  return null;
}

// What is running now, by kind. Listing processes takes 1 s idle and tens of seconds on a CPU at 100%, so one
// count is shared by every session for COUNT_TTL_MS through a small file in the temp folder.
const COUNT_FILE = join(tmpdir(), "cairn-heavy-count.json");
const COUNT_TTL_MS = 5000;
export function running({ fresh = false } = {}) {
  if (!fresh) {
    try {
      const c = JSON.parse(readFileSync(COUNT_FILE, "utf8"));
      if (Date.now() - c.at < COUNT_TTL_MS) return c.counts;
    } catch {
      /* no shared count yet */
    }
  }
  const counts = countNow();
  if (counts) {
    try {
      writeFileSync(COUNT_FILE, JSON.stringify({ at: Date.now(), counts }));
    } catch {
      /* sharing is an optimisation */
    }
  }
  return counts;
}

function countNow() {
  const counts = { browser: 0, simtest: 0, blender: 0, build: 0 };
  let rows = [];
  const w = spawnSync(
    "wmic",
    ["process", "where", "name='chrome.exe' or name='node.exe' or name='blender.exe'", "get", "Name,CommandLine,ProcessId,ParentProcessId", "/format:csv"],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  if (w.status === 0 && w.stdout) {
    rows = w.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith("Node,"))
      .map((l) => l.split(","))
      .filter((parts) => parts.length >= 5) // a command line wrapped onto its own line is not a row
      .map((parts) => {
        // Node,CommandLine,Name,ParentProcessId,ProcessId: the command line may hold commas, so read from the end.
        const pid = parts.pop().trim();
        const ppid = parts.pop().trim();
        const name = parts.pop().trim().toLowerCase();
        return { name, cmd: parts.slice(1).join(","), pid, ppid };
      });
  } else {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='node.exe' or Name='blender.exe'\" | Select-Object Name,CommandLine,ProcessId,ParentProcessId | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30000 },
    );
    try {
      const j = JSON.parse(ps.stdout || "[]");
      rows = (Array.isArray(j) ? j : [j]).map((r) => ({
        name: String(r.Name || "").toLowerCase(),
        cmd: String(r.CommandLine || ""),
        pid: String(r.ProcessId ?? ""),
        ppid: String(r.ParentProcessId ?? ""),
      }));
    } catch {
      return null; // can't see the machine: don't hold anything up
    }
  }
  return tally(rows, counts);
}

// One simtest run is often two processes: tools/simtest.mjs re-spawns itself with a bigger heap (2026-10-21). A
// simtest process whose parent is a simtest process is that child and is not counted again (job #236: one run
// filled both slots).
export function tally(rows, counts = { browser: 0, simtest: 0, blender: 0, build: 0 }) {
  const isSim = (r) => r.name === "node.exe" && (/tools[\\/]simtest\.mjs/.test(r.cmd) || bigHeap(r.cmd));
  const simPids = new Set(rows.filter(isSim).map((r) => String(r.pid)));
  for (const r of rows) {
    const { name, cmd } = r;
    if (name === "chrome.exe" && /--headless/.test(cmd) && !/--type=/.test(cmd)) counts.browser++;
    else if (name === "blender.exe") counts.blender++;
    else if (isSim(r)) {
      if (!(r.ppid && simPids.has(String(r.ppid)))) counts.simtest++;
    }
    else if (name === "node.exe" && /vite[\\/]bin[\\/]vite\.js"?\s+build|vite\.js\s+build|\btsc\b/.test(cmd)) counts.build++;
  }
  return counts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until a slot of `kind` is free, up to `maxMs`. Returns { waitedMs, gaveUp, seen }.
// Claims: a run that is about to start but isn't in the process list yet (a browser takes seconds to appear). Without
// them every waiting run saw the same free slot and all started at once (5 browsers on a limit of 2). Deciding is
// serialised by a lock file, and a claim counts as running for CLAIM_MS.
const CLAIMS = join(tmpdir(), "cairn-heavy-claims");
const CLAIM_MS = 30000;

function recentClaims(kind) {
  let n = 0;
  try {
    for (const f of readdirSync(CLAIMS)) {
      const [k, at] = f.split("_");
      if (k !== kind) continue;
      if (Date.now() - Number(at) < CLAIM_MS) n++;
      else rmSync(join(CLAIMS, f), { force: true });
    }
  } catch {
    /* none yet */
  }
  return n;
}

// Take a slot of `kind` if one is free now. True when this caller may start.
export function tryClaim(kind) {
  mkdirSync(CLAIMS, { recursive: true });
  const lock = join(CLAIMS, `${kind}.lock`);
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { force: true });
    closeSync(openSync(lock, "wx"));
  } catch {
    return false; // someone else is deciding right now
  }
  try {
    const now = running();
    if (now && now[kind] + recentClaims(kind) >= limit(kind)) return false;
    if (kind !== "blender" && freemem() < MIN_FREE_GB * 1024 ** 3) return false; // short of memory: wait
    writeFileSync(join(CLAIMS, `${kind}_${Date.now()}_${process.pid}`), "");
    return true;
  } finally {
    rmSync(lock, { force: true });
  }
}

// `queued` says whether it ever found the kind full (so slow counting alone is never reported as a hold).
export async function waitForSlot(kind, { maxMs = 10 * 60000, pollMs = 5000 } = {}) {
  const start = Date.now();
  let seen = null;
  let queued = false;
  for (;;) {
    const now = running();
    if (!now) return { waitedMs: Date.now() - start, gaveUp: false, seen, queued };
    seen = now[kind];
    if (tryClaim(kind)) return { waitedMs: Date.now() - start, gaveUp: false, seen, queued };
    queued = true;
    if (Date.now() - start >= maxMs) return { waitedMs: Date.now() - start, gaveUp: true, seen, queued };
    await sleep(pollMs + Math.floor(Math.random() * 1500)); // jitter, so queued runs don't all start together
  }
}
