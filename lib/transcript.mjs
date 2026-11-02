// Defensive reader for Claude Code transcript JSONL (docs/CAIRN.md).
// The format is internal and shifts across versions, so this extracts only what
// cairn needs and tolerates unknown shapes: it returns ordered events
//   { role: "user",      text }            — real operator input only
//   { role: "assistant", text }            — assistant prose (thinking excluded)
//   { tool, path }                         — tool call name + file path if any
// Tool RESULTS are deliberately dropped: they carry untrusted content (web
// fetches, dependency source) that must not launder into checkpoints.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";

function blockList(content) {
  return Array.isArray(content) ? content : null;
}

// Events since `fromByte` (preferred: reads only the new tail, and transcripts
// here reach 150 MB) or, for state written before byte offsets, `fromLine`.
// Returns `byteCount`, the offset the next segment starts from, and `lineCount`.
export function readEvents(transcriptPath, { fromLine = 0, fromByte } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { events: [], lineCount: 0, byteCount: 0 };
  let text;
  let start = 0;
  const size = statSync(transcriptPath).size;
  if (Number.isFinite(fromByte) && fromByte > 0 && fromByte <= size) {
    const buf = Buffer.alloc(size - fromByte);
    const fd = openSync(transcriptPath, "r");
    try {
      readSync(fd, buf, 0, buf.length, fromByte);
    } finally {
      closeSync(fd);
    }
    text = buf.toString("utf8");
  } else {
    text = readFileSync(transcriptPath, "utf8");
    start = fromLine;
  }
  const lines = text.split("\n");
  const events = [];
  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row.isSidechain) continue; // subagent chatter
    if (row.timestamp) events.push({ at: row.timestamp });
    const msg = row.message;
    if (row.type === "user" && msg) {
      if (typeof msg.content === "string") {
        if (msg.content.trim()) events.push({ role: "user", text: msg.content });
      } else
        for (const b of blockList(msg.content) || []) {
          if (b.type === "text" && b.text?.trim()) events.push({ role: "user", text: b.text });
          // b.type === "tool_result": dropped by design
        }
    } else if (row.type === "assistant" && msg) {
      for (const b of blockList(msg.content) || []) {
        if (b.type === "text" && b.text?.trim()) {
          events.push({ role: "assistant", text: b.text });
        } else if (b.type === "tool_use") {
          const path = b.input?.file_path || b.input?.path || b.input?.notebook_path || null;
          events.push({ tool: b.name || "unknown", path });
        }
      }
    }
  }
  return { events, lineCount: lines.length, byteCount: size };
}

// Minutes from the first to the last timestamped row, or null when rows carry none.
export function spanMinutes(events) {
  const ts = events.filter((e) => e.at).map((e) => Date.parse(e.at)).filter(Number.isFinite);
  return ts.length >= 2 ? (Math.max(...ts) - Math.min(...ts)) / 60000 : null;
}

export function stats(events) {
  const editTools = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  let assistantTurns = 0,
    edits = 0;
  const filesTouched = new Set();
  for (const e of events) {
    if (e.role === "assistant") assistantTurns++;
    if (e.tool && editTools.has(e.tool)) {
      edits++;
      if (e.path) filesTouched.add(e.path);
    }
  }
  return { assistantTurns, edits, filesTouched: [...filesTouched] };
}

// Compact serialization for the distiller: user/assistant text + tool names/paths
// only. Truncated to the most recent `cap` chars keeping the segment's first
// user message intact.
export function serialize(events, cap = 60000) {
  const parts = events.filter((e) => e.role || e.tool).map((e) =>
    e.role ? `${e.role.toUpperCase()}: ${e.text}` : `TOOL: ${e.tool}${e.path ? " " + e.path : ""}`,
  );
  const firstUser = parts.find((p) => p.startsWith("USER:")) || "";
  let out = parts.join("\n");
  if (out.length > cap) {
    const head = firstUser.slice(0, 2000);
    out = head + "\n[... truncated ...]\n" + out.slice(-(cap - head.length - 24));
  }
  return out;
}
