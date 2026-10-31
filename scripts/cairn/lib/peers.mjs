// Claude Code's own session registry: the names sessions call each other by
// ("seco-70", "Factions") and their status (busy, waiting, idle). Cairn keys
// everything by session id, so without this the board says [0543bd72] while the
// sessions say seco-70, and nobody can tell they are the same.
//
// Source: <config dir>/sessions/<pid>.json, one per running Claude Code process:
//   { pid, sessionId, cwd, name, nameSource, status, kind, updatedAt, ... }
// This is Claude Code's internal file, not a documented API: every read fails
// open to an empty map, and liveness still comes from Cairn's own last_active.
// Read by the CLI and the board only, never written.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./store.mjs";

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function plansDir() {
  return join(configDir(), "plans");
}

// Signal 0 only checks the process exists. EPERM means it exists but isn't ours to signal.
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Map<sessionId, { name, status, kind, updatedAt }> for sessions in this repo.
export function peers(cwd) {
  const out = new Map();
  try {
    const dir = join(configDir(), "sessions");
    const root = norm(repoRoot(cwd));
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const at = norm(j.cwd); // a session that cd'd into a subfolder is still in this repo
        if (!j.sessionId || (at !== root && !at.startsWith(root + "/"))) continue;
        if (j.pid && !alive(j.pid)) continue; // a file left behind by a process that has exited
        const prev = out.get(j.sessionId);
        if (prev && prev.updatedAt > (j.updatedAt || 0)) continue;
        out.set(j.sessionId, {
          name: j.name || null,
          status: j.status || null,
          kind: j.kind || null,
          updatedAt: j.updatedAt || 0,
          socket: j.messagingSocketPath || null,
        });
      } catch {
        /* a half-written or foreign file */
      }
    }
  } catch {
    /* no registry: callers fall back to the bare id */
  }
  return out;
}

// The session name a SendMessage `to` refers to: "Factions", "Factions [ab12cd]",
// or a reply's pipe address ("uds:\\.\pipe\LOCAL\cc-msg-…"), matched to the
// registry's messagingSocketPath. Anything unmatched comes back as given.
// The session id behind a SendMessage address (a name, "name [ref]" or "uds:<pipe>"), or null. Names change when
// Claude Code renames a session (all of them did at once on 2026-10-15); ids don't, so replies are matched by id.
export function idFor(peerMap, to) {
  const t = String(to || "").trim();
  const pipe = /^uds:/i.test(t) ? t.slice(4).toLowerCase() : null;
  const name = t.replace(/s*[[0-9a-f]+]$/i, "").toLowerCase();
  for (const [id, p] of peerMap) {
    if (pipe ? p.socket && p.socket.toLowerCase() === pipe : p.name && p.name.toLowerCase() === name) return id;
  }
  return null;
}

export function nameFor(peerMap, to) {
  const t = String(to || "").trim();
  if (/^uds:/i.test(t)) {
    const pipe = t.slice(4).toLowerCase();
    for (const p of peerMap.values()) if (p.socket && p.socket.toLowerCase() === pipe) return p.name || t;
    return t;
  }
  return t.replace(/\s*\[[0-9a-f]+\]$/i, "");
}

// "seco-70 · 0543bd72", or the bare short id when the registry has no name.
export function label(sessionId, peerMap, nameHint) {
  const id = String(sessionId || "").slice(0, 8);
  const name = peerMap?.get(sessionId)?.name || nameHint;
  return name ? `${name} · ${id}` : id;
}
