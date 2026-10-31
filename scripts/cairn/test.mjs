#!/usr/bin/env node
// `pnpm simtest`, `pnpm playtest`, `pnpm build`: ask the shared test queue (lib/testq.mjs) for a result. Prints the
// run's output and exits with its code, exactly as running the test directly would, plus a note on stderr when the
// run was shared or queued. Usage: node scripts/cairn/test.mjs <simtest|playtest|build> [args...]
// CAIRN_TESTQ=0 runs the test directly, bypassing the queue.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { peers } from "./lib/peers.mjs";
import { request, TESTS } from "./lib/testq.mjs";

const [name, ...rest] = process.argv.slice(2);
const args = rest[0] === "--" ? rest.slice(1) : rest;
if (!TESTS[name]) {
  console.error(`usage: test.mjs <${Object.keys(TESTS).join("|")}> [args...]`);
  process.exit(2);
}
const cwd = process.cwd();

if (process.env.CAIRN_TESTQ === "0") {
  const r = spawnSync(`${TESTS[name].command} ${args.join(" ")}`, { cwd, shell: true, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const sid = process.env.CLAUDE_CODE_SESSION_ID;
const requester = (sid && peers(cwd).get(sid)?.name) || (sid ? sid.slice(0, 8) : "a person");
const note = (m) => process.stderr.write(`[test queue] ${m}\n`);

const { run, shared, waitedMs } = await request(cwd, name, args, { requester, onWait: note });
process.stdout.write(readFileSync(run.log, "utf8"));
const secs = Math.round(waitedMs / 1000);
if (shared) note(`result shared from the run ${run.by} started at ${new Date(run.startedAt).toTimeString().slice(0, 8)} (exit ${run.exit})`);
else if (secs > 5) note(`ran after ${secs} s in the queue (exit ${run.exit})`);
process.exit(run.exit);
