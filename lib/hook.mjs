// Shared hook harness (docs/CAIRN.md §failure policy): every cairn hook reads a
// JSON payload from stdin and MUST exit 0 no matter what — on any internal error
// it logs locally and emits nothing. Cairn advises; it never blocks the operator.

import { log } from "./store.mjs";

export async function hookMain(name, fn) {
  if (process.env.CAIRN_DISABLE) process.exit(0);
  let payload = {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    /* run with empty payload; fn may still no-op */
  }
  const cwd = payload.cwd || process.cwd();
  try {
    const out = await fn(payload, cwd);
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  } catch (err) {
    log(cwd, `${name}: ${err?.stack || err}`);
    process.exit(0);
  }
}
