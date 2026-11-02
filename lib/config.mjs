// Per-project settings: the `project` block of .claude/cairn/config.json, merged over neutral defaults.
// Everything that used to be written into the code for one game (test commands, heavy-run patterns, the tuning
// check files, the person's name) lives here, so Cairn drops into another repo without code edits.
// CAIRN_CONFIG=<path to a config.json> overrides the file (the selftest uses it). No imports from store.mjs, so
// any module can read it without a cycle.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULTS = {
  // Who the sessions work for, as Cairn's messages name them.
  person: "the user",
  // The shared test queue (lib/testq.mjs): name -> { kind, command }. Empty: `test.mjs` has nothing to run.
  tests: {},
  // Folders and files whose changes invalidate a finished test run. Empty: every request gets a fresh run.
  source: [],
  skip: ["node_modules", "dist", "build", "out", "coverage", "__pycache__", ".git", ".next", "target"],
  heavy: {
    // [{ kind, match }]: a command matching the regex `match` (quoted text removed) is a heavy run of `kind`.
    rules: [],
    // { "<path tail of a node script>": kind }, e.g. { "tools/simtest.mjs": "simtest" }.
    scripts: {},
    limits: {},
  },
  // Shell command that checks docs rules, named in the first-edit-in-an-area note. null: not mentioned.
  docsCheck: null,
  // Globs (matched on the path's tail) of check files only the tuning role edits freely. Empty: no hold.
  checkFiles: [],
  // Words the unslop pass must leave alone in this project (e.g. "crucial" in a game with a Crucial item).
  unslopLiterals: [],
  // The knowledge graph (lib/graph/). See lib/graph/config.mjs for the keys.
  graph: {},
};

let cached = null;
let cachedFor = null;

const roots = new Map();
function root(cwd) {
  if (roots.has(cwd)) return roots.get(cwd);
  let r = cwd;
  try {
    r = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    /* not a repo */
  }
  roots.set(cwd, r);
  return r;
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(base?.[k]) && isObj(v) ? merge(base[k], v) : v;
  return out;
}

export function configPath(cwd = process.cwd()) {
  return process.env.CAIRN_CONFIG || join(root(cwd), ".claude", "cairn", "config.json");
}

// Read once per process (hooks are short-lived); `fresh` re-reads.
export function projectConfig(cwd = process.cwd(), { fresh = false } = {}) {
  const path = configPath(cwd);
  if (!fresh && cached && cachedFor === path) return cached;
  let project = {};
  try {
    project = JSON.parse(readFileSync(path, "utf8")).project || {};
  } catch {
    /* no config: defaults */
  }
  cached = merge(DEFAULTS, project);
  cachedFor = path;
  return cached;
}

export const person = (cwd) => projectConfig(cwd).person || DEFAULTS.person;
export const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

// A glob to a regex: `**` any depth, `*` within a segment, a trailing `/` owns a folder.
export function globRegex(pattern, { tail = false } = {}) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        re += "(?:.*/)?"; // `**/` is zero or more folders
        i++;
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const head = tail ? "(?:^|/)" : "^";
  if (pattern.endsWith("/")) return new RegExp(`${head}${re}`);
  return new RegExp(`${head}${re}(?:/.*)?$`);
}
