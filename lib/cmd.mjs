// Where this copy of Cairn runs from, and so how sessions should call it. A project either has cairn-agent as a
// devDependency (hooks run from <repo>/node_modules/cairn-agent, the version pinned with the repo; call it with
// `npx cairn`) or uses the global install (`npm i -g cairn-agent`; call it with `cairn`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_NAME = "cairn-agent";
export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = join(PKG_ROOT, "bin", "cairn.mjs");
export const HOOKS_DIR = join(PKG_ROOT, "hooks");

// True when this copy is a project's own (…/node_modules/cairn-agent/…).
export function isLocal() {
  return PKG_ROOT.split(sep).join("/").includes(`/node_modules/${PKG_NAME}`);
}

// The command a session should type: "npx cairn" for a project's own copy, else "cairn".
export const cli = () => (isLocal() ? "npx cairn" : "cairn");

export function version() {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

// Is cairn-agent installed in this project (so init should wire hooks to it)?
export function installedIn(root) {
  return existsSync(join(root, "node_modules", PKG_NAME, "package.json"));
}

// The hook command and the allow rule for each mode.
export function hookCommand(mode, name) {
  return mode === "local" ? `node "$CLAUDE_PROJECT_DIR/node_modules/${PKG_NAME}/hooks/${name}.mjs"` : `cairn hook ${name}`;
}
export const allowRule = (mode) => (mode === "local" ? "Bash(npx cairn:*)" : "Bash(cairn:*)");

// A hook entry is Cairn's (any version or mode) if its command names one of these.
export const HOOK_MARKERS = ["scripts/cairn/hooks", `${PKG_NAME}/hooks/`, "cairn hook "];
export const LEGACY_ALLOW = "Bash(node scripts/cairn/cairn.mjs:*)";
