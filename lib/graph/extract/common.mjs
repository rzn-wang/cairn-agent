// Shared helpers for the per-language extractors: comment stripping that keeps
// offsets (and so line numbers) intact, offset → line lookup, and the symbol
// finishing pass (block hashes, cap). Pure — no fs.

import { createHash } from "node:crypto";

const MAX_BLOCK = 4096;

export function blank(s) {
  return s.replace(/[^\n]/g, " ");
}

// Every stripper regex has group 1 = text to blank (a comment or docstring);
// anything else it matches (string literals) is kept, so a "//" inside a string
// never starts a comment and import specifiers survive.
function stripWith(text, re) {
  return text.replace(re, (m, drop) => (drop !== undefined ? blank(drop) : m));
}

const DQ = String.raw`"(?:[^"\\\n]|\\[\s\S])*"`;
const SQ = String.raw`'(?:[^'\\\n]|\\[\s\S])*'`;
const BT = String.raw`\x60(?:[^\x60\\]|\\[\s\S])*\x60`;
const LINE = String.raw`\/\/[^\n]*`;
// An unterminated /* runs to EOF (as the compiler sees it) — and must, or every
// later /* would rescan to EOF: quadratic.
const BLOCK = String.raw`\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`;

const RE = {
  js: new RegExp(`(${LINE}|${BLOCK})|${DQ}|${SQ}|${BT}`, "g"),
  // Go raw strings are backticked and multi-line; runes look like 'x'.
  go: new RegExp(`(${LINE}|${BLOCK})|${DQ}|\\x60[^\\x60]*\\x60|${SQ}`, "g"),
  // Rust: '...' is only a char literal when it is one (escaped) char — otherwise
  // it's a lifetime ('a, 'static) and must not open a string.
  rust: new RegExp(`(${LINE}|${BLOCK})|${DQ}|'(?:\\\\[^']{1,10}|[^'\\\\\\n])'`, "g"),
  // Java text blocks / Kotlin and Scala raw strings.
  jvm: new RegExp(`(${LINE}|${BLOCK})|"""[\\s\\S]*?"""|${DQ}|${SQ}`, "g"),
  csharp: new RegExp(`(${LINE}|${BLOCK})|@"(?:[^"]|"")*"|${DQ}|${SQ}`, "g"),
  cfamily: new RegExp(`(${LINE}|${BLOCK})|${DQ}|${SQ}`, "g"),
  // Triple-quoted strings are blanked too: docstrings must not yield symbols.
  python: new RegExp(`("""[\\s\\S]*?"""|'''[\\s\\S]*?'''|#[^\\n]*)|${DQ}|${SQ}`, "g"),
  ruby: new RegExp(`(^=begin\\b[\\s\\S]*?(?:^=end\\b[^\\n]*|(?![\\s\\S]))|#[^\\n]*)|${DQ}|${SQ}`, "gm"),
  // PHP 8 attributes start with #[ and are not comments.
  php: new RegExp(`(${LINE}|${BLOCK}|#(?!\\[)[^\\n]*)|${DQ}|${SQ}`, "g"),
  markdown: /(<!--[\s\S]*?(?:-->|(?![\s\S])))/g,
};

const HEREDOC_OPEN = /<<[~-]?(['"]?)([A-Za-z_]\w*)\1[^\n]*\n/g;

// Blank heredoc bodies. A tag whose terminator wasn't found once can't be found
// from any later point either, so each tag fails at most once: linear overall.
function stripHeredocs(text) {
  const parts = [];
  const missing = new Set();
  let last = 0;
  HEREDOC_OPEN.lastIndex = 0;
  for (let m; (m = HEREDOC_OPEN.exec(text)); ) {
    const tag = m[2];
    if (missing.has(tag)) continue;
    const bodyStart = m.index + m[0].length;
    const end = new RegExp(`^[ \\t]*${tag}\\b`, "gm");
    end.lastIndex = bodyStart;
    const e = end.exec(text);
    if (!e) {
      missing.add(tag);
      continue;
    }
    parts.push(text.slice(last, bodyStart), blank(text.slice(bodyStart, e.index)));
    last = e.index;
    HEREDOC_OPEN.lastIndex = e.index;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

export function stripComments(text, lang) {
  const re = RE[lang];
  if (!re) return text;
  let out = stripWith(text, re);
  if (lang === "ruby" || lang === "php") out = stripHeredocs(out);
  return out;
}

// Offset → 1-based line, by binary search over line starts.
export function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { starts, lineOf };
}

// "a, b as c, type d" → ["a", "b", "d"]: the imported (not local) names.
export function splitNames(list, asWord = "as") {
  const out = [];
  for (let part of String(list).split(",")) {
    part = part.replace(/[(){}\\\n]/g, " ").trim().replace(/^type\s+/, "");
    if (!part) continue;
    const name = part.split(new RegExp(`\\s+${asWord}\\s+`))[0].trim();
    if (/^[\w$*.:\\]+$/.test(name)) out.push(name);
  }
  return out;
}

function sha12(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Raw symbols ({ name, kind, line, exported }) → deduped, hashed and capped.
// A symbol's block runs to the next symbol's line (or EOF), capped at 4 KB.
export function finishSymbols(raw, clean, starts, maxSymbols) {
  const seen = new Set();
  const syms = [];
  for (const s of raw.sort((a, b) => a.line - b.line)) {
    if (!s.name) continue;
    const key = `${s.name}@${s.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    syms.push(s);
  }
  const lines = [...new Set(syms.map((s) => s.line))];
  const nextLine = new Map(lines.map((l, i) => [l, lines[i + 1]]));
  // Pick the survivors first so a huge file only pays for hashing what it keeps.
  let kept = syms;
  if (syms.length > maxSymbols) {
    const keep = new Set(
      [...syms].sort((a, b) => (b.exported ? 1 : 0) - (a.exported ? 1 : 0) || a.line - b.line).slice(0, maxSymbols),
    );
    kept = syms.filter((s) => keep.has(s));
  }
  for (const s of kept) {
    const from = starts[s.line - 1] ?? 0;
    const next = nextLine.get(s.line);
    const to = next ? starts[next - 1] : clean.length;
    const flat = clean.slice(from, Math.min(to, from + MAX_BLOCK)).replace(/\s+/g, " ").trim();
    s.hash = sha12(flat);
    // Strip the bare name (the method part of "T.N" too) so a pure rename keeps hash2.
    const short = s.name.includes(".") ? s.name.slice(s.name.lastIndexOf(".") + 1) : s.name;
    const re = new RegExp(`(?<![\\w$])${escapeRe(short)}(?![\\w$])`, "g");
    s.hash2 = sha12(flat.replace(re, "").replace(/ {2,}/g, " ").trim());
  }
  return kept;
}

// Pushes every match of `re` (which must be global) as fn(match, offset).
export function each(text, re, fn) {
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) fn(m, m.index);
}
