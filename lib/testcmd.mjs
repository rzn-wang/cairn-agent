// `cairn test <name> [args]`, which the project's own scripts call (config `tests`; e.g. "test": "cairn test simtest"):
// ask the shared test queue (lib/testq.mjs) for a result. Prints the run's output and exits with its code, exactly
// as running the test directly would, plus a note on stderr when the run was shared or queued.
// CAIRN_TESTQ=0 runs the test directly, bypassing the queue.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { peers } from "./peers.mjs";
import { request, TESTS } from "./testq.mjs";

const argv = process.argv.slice(2);
const [name, ...rest] = argv[0] === "test" ? argv.slice(1) : argv;
const args = rest[0] === "--" ? rest.slice(1) : rest;
if (!TESTS[name]) {
  const names = Object.keys(TESTS);
  console.error(
    names.length
      ? `usage: cairn test <${names.join("|")}> [args...]`
      : 'cairn test: no tests configured. Add them to .claude/cairn/config.json, e.g. "project": { "tests": { "build": { "kind": "build", "command": "npm run build" } } }',
  );
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
