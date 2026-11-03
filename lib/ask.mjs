// Questions left in prose (docs/WORKING.md section 7): when a turn ends with
// questions for Robin written into the reply instead of asked with the
// AskUserQuestion tool, the Stop hook sends the session back once to ask them
// properly, so Robin answers in a box rather than hunting through a summary.
//
// Reads only the transcript tail since the last prompt. Heuristic and cautious:
// a question must be a line of its own (or a list item) ending in "?", outside
// code and quotes, in the last part of the reply, and either addressed to the
// reader or under a heading about questions or decisions.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const TAIL = 512 * 1024;
const ADDRESSED =
  /\b(you|your|robin|should i|shall i|shall we|should we|want me|do you|would you|which|ok to|okay to|go ahead|can i|may i|prefer|confirm|or (?:would|should|do))\b/i;
const QUESTION_HEADING = /^#{1,4}\s*.*\b(questions?|decisions?|for you|open|your call|to decide)\b/i;

function tailRows(path) {
  if (!path || !existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const rows = [];
  for (const line of buf.toString("utf8").split("\n").slice(start ? 1 : 0)) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* torn or partial line */
    }
  }
  return rows;
}

// The current turn: assistant rows after the last prompt (a user row carrying text, not a tool result).
export function lastTurn(path) {
  const rows = tailRows(path).filter((r) => !r.isSidechain);
  let i = rows.length - 1;
  for (; i >= 0; i--) {
    const r = rows[i];
    if (r.type !== "user" || r.isMeta) continue;
    const c = r.message?.content;
    if (typeof c === "string" ? c.trim() : (c || []).some((b) => b.type === "text" && b.text?.trim())) break;
  }
  const texts = [];
  const tools = [];
  for (const r of rows.slice(i + 1)) {
    if (r.type !== "assistant") continue;
    for (const b of r.message?.content || []) {
      if (b.type === "text" && b.text?.trim()) texts.push(b.text);
      if (b.type === "tool_use") tools.push(b.name);
    }
  }
  return { texts, tools };
}

// Question lines in a reply, in order; [] when there are none worth a box.
export function proseQuestions(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let inCode = false;
  let underHeading = false;
  const from = Math.floor(lines.length * 0.4); // the closing part of the reply
  lines.forEach((raw, n) => {
    const line = raw.trim();
    if (line.startsWith("```")) inCode = !inCode;
    if (inCode || !line) return;
    if (/^#{1,4}\s/.test(line)) underHeading = QUESTION_HEADING.test(line);
    if (/^\*\*[^*]+\*\*:?$/.test(line)) underHeading = QUESTION_HEADING.test("# " + line.replace(/\*/g, ""));
    if (line.startsWith(">")) return;
    if (n < from && !underHeading) return;
    // Sentence by sentence: "Which device are you on? I'll set it up." asks, mid-line.
    const body = line.replace(/^([-*]|\d+\.)\s+/, "").replace(/\*\*|__|`/g, "");
    for (const s of body.split(/(?<=[?.!])\s+/)) {
      const q = s.replace(/[*_)\]]+$/, "").trim();
      if (!q.endsWith("?") || q.length < 12) continue;
      if (underHeading || ADDRESSED.test(q)) out.push(q);
    }
  });
  return out;
}

// Asking leave to carry on with work the session already has, which Robin doesn't want asked
// (2026-10-07): "Should I go ahead?", "Want me to start on X?", "What should I do next?". A real
// decision ("Which colour for the sails?", "Should the oil start at 30?") doesn't match.
const PERMISSION =
  /^(?:(?:so|ok|okay|then),?\s+)?(?:(?:should|shall|can|may) (?:i|we)|(?:do you )?want me to|would you like me to|(?:are you )?(?:ok|okay|happy|fine) (?:with me|for me|if i)|ready for me to)\s+(?:go ahead|continue|proceed|carry on|keep going|move on|start|begin|get started|go on|do (?:that|this|it|the rest|those)|file|post|send|set (?:it|that|them) up|take (?:it|that|them|job)|work on|pick up|fix (?:it|that|them)|run)\b|^what (?:should|shall|do you want) (?:i|me to) (?:do|work on|tackle|pick up)(?: next)?\b|^(?:which|what) (?:should|shall) i (?:do|start|tackle|work on) (?:first|next)\b|^(?:go ahead|continue|proceed)\?/i;

export function isPermissionQuestion(q) {
  return PERMISSION.test(String(q || "").trim());
}

// What the Stop hook should do: null, or the questions the session left in prose,
// split into real decisions and requests for leave to carry on.
// A reply that ends by saying the session waits on Robin ("Still waiting on you: …", "Blocked on Robin's yes",
// "Needs your call") instead of asking him (Robin, 2026-10-15: "let them just do an AskUserQuestion to me"). Only the
// session speaking for itself: at a line's start (after bullets, bold and an "Open:" label) or after I'm / we're /
// still; "the tuning agent is waiting on you" is a report about someone else and doesn't count.
const LEAD =
  /(?:^[ \t>*\-#\d.)]*(?:\*\*)?(?:(?:open|left|next|status|blocked|pending)[^:\n]{0,20}:(?:\*\*)?\s*)?|\b(?:i'?m|i am|we'?re|we are|still|now|currently)\s+)/
    .source;
const WAITING = new RegExp(
  LEAD +
    /(?:still\s+)?(?:(?:waiting|blocked|held)\s+(?:on|for)\s+(?:you|robin|your)\b|awaiting\s+(?:your|robin)|needs?\s+(?:your|robin'?s)\s+(?:call|decision|answer|yes|approval|eye|go-ahead|input)|your\s+call\b)/
      .source,
  "im",
);
// A decision handed to Robin as a statement, anywhere in a closing line ("The master's share is your decision",
// "needs its own plan and your answers", "Three decisions are yours", "up to you"): present tense only, so a report
// of what he already decided ("as you decided", "you answered") doesn't count.
const HANDED = new RegExp(
  [
    /\b(?:is|are|stays?|remains?)\s+(?:your|robin'?s)\s+(?:decision|call|choice|pick)\b/,
    /\b(?:decisions?|questions?|choices?)\s+(?:is|are)\s+(?:yours|for you|robin'?s)\b/,
    /\bneeds?\b[^.?!\n]{0,50}\b(?:your|robin'?s)\s+(?:answers?|decisions?|call|yes|approval|go-ahead|input|eye)\b/,
    /\bfor (?:you|robin) to (?:decide|choose|pick|answer|approve|confirm)\b/,
    /\bup to you\b/,
    /\b(?:once|when|after) you (?:decide|answer|pick|choose|approve|confirm|sign off)\b/,
  ]
    .map((r) => r.source)
    .join("|"),
  "i",
);
export function waitingOnRobin(text) {
  // The closing part, from a whole line: a cut mid-line pairs the quotes wrongly and unquotes an example.
  const all = String(text || "");
  const tail = all.length > 1500 ? all.slice(-1500).replace(/^[^\n]*\n/, "") : all;
  // Quoted text and inline code are examples, not the session speaking ("such as "Still waiting on you"").
  const spoken = (l) => l.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, " ");
  return tail
    .split("\n")
    .filter((l) => WAITING.test(spoken(l)) || HANDED.test(spoken(l)))
    .map((l) => l.trim());
}

export function questionsLeftInProse(transcriptPath) {
  const { texts, tools } = lastTurn(transcriptPath);
  if (!texts.length || tools.includes("AskUserQuestion")) return null;
  const last = texts[texts.length - 1];
  const qs = proseQuestions(last);
  const waits = waitingOnRobin(last);
  if (!qs.length && !waits.length) return null;
  return { decisions: qs.filter((q) => !isPermissionQuestion(q)), leave: qs.filter(isPermissionQuestion), waits };
}

