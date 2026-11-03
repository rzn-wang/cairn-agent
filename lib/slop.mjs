// Unslop: strip AI filler from the prose Cairn stores and relays (learnings, notices, threads, checkpoints,
// messages between sessions). A JavaScript port of the deterministic "balanced" pass of
// MohamedAbdallah-14/unslop (MIT, unslop/scripts/humanize.py), cut down for an engineering repo.
// Robin, 2026-11-01: port to JS, cover all four kinds of text, fix rather than flag (docs/design/cairn-unslop.md).
//
// What it never touches: fenced and indented code, inline code, URLs, markdown links, headings, tables,
// blockquotes and "quoted" phrases (a quote is a mention, not a use). Those are swapped for placeholders first.
//
// Left out of the port on purpose: "realm", "landscape", "navigate", "journey", "vibrant" and "game-changing",
// which are literal in many projects (games, maps, UI). Config `unslopLiterals` keeps more words as written. Also left out: the "However," rule, which breaks real
// contrasts in technical notes; the filler-phrase and negative-parallelism rules (unslop's "full" level only);
// and the structural and LLM passes. CAIRN_UNSLOP=0 turns the pass off.

import { projectConfig } from "./config.mjs";

const PROTECT = [
  ["FENCE", /^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm],
  ["INDENT", /^(?: {4}|\t)[^\n]+(?:\n(?: {4}|\t)[^\n]+)*/gm],
  ["TABLE", /^[ \t]*\|[^\n]*\|[ \t]*(?:\n[ \t]*\|[^\n]*\|[ \t]*)+/gm],
  ["QUOTE", /^[ \t]*>[^\n]*(?:\n[ \t]*>[^\n]*)*/gm],
  ["HEAD", /^#{1,6}[ \t]+[^\n]+/gm],
  ["LINK", /\[[^\]\n]+\]\([^)\n]+\)/g],
  ["INLINE", /`[^`\n]+`/g],
  ["URL", /https?:\/\/[^\s)>\]]+/g],
  // File paths: anything with a folder separator and an extension, or a bare name with a known source extension.
  // "src/comprehensive.ts" is a name, not prose.
  ["PATH", /(?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w.-]+\.\w{1,8}\b|(?:[\w@.-]+\/){2,}[\w.-]*|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|scala|cs|cpp|cc|cxx|c|h|hpp|rb|php|swift|vue|svelte|md|mdx|json|ya?ml|toml|sh|css|scss|html|sql)\b/g],
  ["QUOTED", /"[^"\n]{1,160}"|“[^”\n]{1,160}”/g],
];

function protect(text) {
  const table = [];
  for (const [kind, re] of PROTECT)
    text = text.replace(re, (m) => {
      table.push(m);
      return `\u0000${kind}#${table.length - 1}\u0000`;
    });
  return { text, table };
}

function restore(text, table) {
  for (let i = table.length - 1; i >= 0; i--) text = text.replace(new RegExp(`\u0000[A-Z]+#${i}\u0000`, "g"), () => table[i]);
  return text;
}

// Sentence start: line start, or after ". " / "! " / "? ".
const S = "(^|(?<=[.!?]\\s))";
const LI = "(^[ \\t]*(?:[-*+]|\\d+\\.)[ \\t]+)"; // list-item start
const at = (body, flags = "gm") => [new RegExp(S + body, flags), new RegExp(LI + body, flags)];

const SYCOPHANCY = [
  /^[ \t]*(?:Great|Excellent|Wonderful|Fantastic|Awesome) question[^.!\n]*[.!]?[ \t]*/gim,
  /^[ \t]*(?:Certainly|Absolutely|Sure)[!.,][ \t]*/gim,
  /(?<=[.!?]\s)(?:Certainly|Absolutely|Sure)[!.,][ \t]*/gi,
  /^[ \t]*I(?:'m| am) happy to help[^.!\n]*[.!]?[ \t]*/gim,
  /^[ \t]*I(?:'d| would) be happy to help[^.!\n]*[.!]?[ \t]*/gim,
  /(?<=[.!?]\s)I(?:'d| would) be happy to help[^.!\n]*[.!]?[ \t]*/gi,
  /^[ \t]*What a (?:fascinating|wonderful|great|terrific)[^.!\n]*[.!]?[ \t]*/gim,
  /^[ \t]*Thank you for (?:your |the )?(?:question|asking)[^.!\n]*[.!]?[ \t]*/gim,
];

const HEDGING = [
  /\bIt(?:'s| is) (?:also )?important to note that,?[ \t]*/gi,
  /\bIt(?:'s| is) (?:also )?worth (?:mentioning|noting|pointing out) that,?[ \t]*/gi,
  /\bIt should be noted that,?[ \t]*/gi,
  /\bIt(?:'s| is) a well[- ]known fact that,?[ \t]*/gi,
  /\bNeedless to say,?[ \t]+/gi,
  /\bGenerally speaking,?[ \t]+/gi,
  /\bIn essence,?[ \t]+/gi,
];

// Stripped only at a sentence or list-item start, keeping what came before ($1).
const OPENERS = [
  ...at("(?:Furthermore|Moreover|Additionally),?[ \\t]+"),
  ...at("In conclusion,?[ \\t]+"),
  ...at("To summarize,?[ \\t]+"),
  ...at("At its core,?[ \\t]+"),
  ...at("Fundamentally,?[ \\t]+"),
  ...at("In reality,?[ \\t]+"),
  new RegExp(S + "What really matters is(?: that)?,?[ \\t]+", "gim"),
  new RegExp(S + "Let(?:'s| us) dive in(?:to [^.!?\\n]+)?[.!]?[ \\t]*", "gim"),
  new RegExp(S + "Let(?:'s| us) (?:break|walk) (?:this|it) down[.!]?[ \\t]*", "gim"),
  new RegExp(S + "Here'?s what you need to know[:.!]?[ \\t]*", "gim"),
  new RegExp(S + "Without further ado,?[ \\t]*", "gim"),
  new RegExp(S + "Buckle up[.!]?[ \\t]*", "gim"),
];

const VOCAB = [
  [/\bdelving into\b/gi, "looking at"],
  [/\bdelves into\b/gi, "looks at"],
  [/\bdelved into\b/gi, "looked at"],
  [/\bdelve into\b/gi, "look at"],
  [/\btapestry\b/gi, "mix"],
  [/\b(?:stand(?:s|ing)?|stood)\s+as\s+(?:a|an|the)\s+testament\s+to\b/gi, "shows"],
  [/\b(?:is|was)\s+(?:a|the)\s+testament\s+to\b/gi, "shows"],
  [/\b(?:are|were)\s+(?:a|the)\s+testament\s+to\b/gi, "show"],
  [/\b(?:a|the)\s+testament\s+to\b/gi, "proof of"],
  [/\bpivotal\b/gi, "key"],
  [/\bparamount\b/gi, "essential"],
  [/\bseamlessly\b/gi, "smoothly"],
  [/\bseamless\b/gi, "smooth"],
  [/\bholistically\b/gi, "as a whole"],
  [/\bholistic\b/gi, "overall"],
  [/\bleverages\b/gi, "uses"],
  [/\bleveraged\b/gi, "used"],
  [/\bleveraging\b/gi, "using"],
  [/\bleverage\b/gi, "use"],
  [/\bcutting-edge\b/gi, "advanced"],
  [/\bstate-of-the-art\b/gi, "latest"],
  [/\bcomprehensively\b/gi, "thoroughly"],
  [/\bcomprehensive\b/gi, "thorough"],
  [/\bfostering\b/gi, "building"],
  [/\bfosters\b/gi, "builds"],
  [/\bfostered\b/gi, "built"],
  [/\bfoster\b/gi, "build"],
  [/\bshowcasing\b/gi, "showing"],
  [/\bshowcases\b/gi, "shows"],
  [/\bshowcased\b/gi, "showed"],
  [/\bshowcase\b/gi, "show"],
  [/\bfast-paced\b/gi, "fast"],
  [/\bgroundbreaking\b/gi, "new"],
  [/\binterplay\s+(?:between|of)\b/gi, "link between"],
  [/\bintricate\b/gi, "detailed"],
  [/\bunderscores\s+(?=(?:the|our|a|an|its|their|this|that|how|why)\b)/gi, "shows "],
  [/\bunderscored\s+(?=(?:the|our|a|an|its|their|this|that|how|why)\b)/gi, "showed "],
  [/\bunderscoring\s+(?=(?:the|our|a|an|its|their|this|that|how|why)\b)/gi, "showing "],
  [/\bunderscore\s+(?=(?:the|our|a|an|its|their|this|that|how|why)\b)/gi, "show "],
  [/\bcrucial\b/gi, "important"],
  [/\bvital(?=\s+(?:role|importance|part|component|aspect))\b/gi, "important"],
  [/\bever[- ](?:evolving|changing)\b/gi, "changing"],
  [/\bmeticulously\b/gi, "carefully"],
  [/\bmeticulous\b/gi, "careful"],
  [/\bparadigm\s+shift\b/gi, "shift"],
  [/\btransformative\b/gi, "major"],
  [/\ba\s+myriad\s+of\b/gi, "many"],
  [/\ba\s+plethora\s+of\b/gi, "many"],
  [/\bsynergies\b/gi, "shared benefits"],
  [/\bsynergy\b/gi, "shared benefit"],
  [/\bnuanced\b(?=\s+(?:understanding|view|perspective|approach|analysis|take))/gi, "detailed"],
];

// Keep the case of the first letter: "Crucial" → "Important".
const matchCase = (before, after) =>
  /^[A-Z]/.test(before) && /^[a-z]/.test(after) ? after[0].toUpperCase() + after.slice(1) : after;

// At most two em-dashes per paragraph (per list item in a list); the rest become commas.
function capDashes(text, max = 2) {
  const capBlock = (block) => {
    let n = 0;
    return block.replace(/[ \t]?—[ \t]?/g, (m) => (++n <= max ? m : ", "));
  };
  return text
    .split("\n\n")
    .map((para) => {
      const lines = para.split("\n");
      if (!lines.some((l) => /^[ \t]*(?:[-*+]|\d+\.)[ \t]/.test(l))) return capBlock(para);
      const chunks = [];
      for (const l of lines)
        if (/^[ \t]*(?:[-*+]|\d+\.)[ \t]/.test(l) || !chunks.length) chunks.push([l]);
        else chunks[chunks.length - 1].push(l);
      return chunks.map((c) => capBlock(c.join("\n"))).join("\n");
    })
    .join("\n\n");
}

const CUT = "\u0001";
const ABBREV = /(?:^|[^a-zA-Z])(?:i\.e|e\.g|etc|vs|cf|viz|et al|Dr|Mr|Mrs|Ms|St|Jr|Sr|No)$/;

export const enabled = () => process.env.CAIRN_UNSLOP !== "0";

// Returns { text, changes: [{ rule, before, after }] }. Text with nothing to fix comes back byte for byte.
export function unslop(input) {
  const original = String(input ?? "");
  if (!enabled() || !original.trim()) return { text: original, changes: [] };
  const changes = [];
  const sub = (s, re, repl, rule) =>
    s.replace(re, (...m) => {
      const groups = m.slice(1, -2);
      const before = m[0];
      const [off, str] = m.slice(-2);
      // "e.g. sure" is not a new sentence: a cut never follows an abbreviation.
      if (rule !== "stock-word" && /\b(?:e\.g|i\.e|etc|vs|cf)\.\s+$/i.test(str.slice(Math.max(0, off - 8), off))) return before;
      const after = typeof repl === "function" ? repl(before, ...groups) : repl.replace(/\$1/g, groups[0] ?? "");
      if (after !== before) changes.push({ rule, before: before.trim(), after: after.trim() });
      return after;
    });

  let { text, table } = protect(original);
  // CUT marks where a phrase was removed, so only the word after a cut is re-capitalised.
  for (let pass = 0; pass < 5; pass++) {
    const was = text;
    for (const re of SYCOPHANCY) text = sub(text, re, CUT, "sycophancy");
    if (text === was) break;
  }
  for (const re of HEDGING) text = sub(text, re, CUT, "hedging");
  for (const re of OPENERS) text = sub(text, re, "$1" + CUT, "opener");
  const literals = new Set((projectConfig().unslopLiterals || []).map((w) => String(w).toLowerCase()));
  for (const [re, to] of VOCAB)
    text = sub(text, re, (b) => (literals.has(b.toLowerCase().trim()) ? b : matchCase(b, to)), "stock-word");
  const dashes = (text.match(/—/g) || []).length;
  text = capDashes(text);
  if ((text.match(/—/g) || []).length < dashes) changes.push({ rule: "em-dash", before: `${dashes} em-dashes`, after: "max 2 per paragraph" });
  if (!changes.length) return { text: original, changes };

  // Tidy what the cuts left behind: stray punctuation, a lowercase word now starting a sentence, doubled spaces.
  text = text.replace(new RegExp(`(^|\\n)([ \\t]*)${CUT}+[,;:]?[ \\t]*`, "g"), `$1$2${CUT}`);
  text = text.replace(new RegExp(`${CUT}+([a-z])`, "g"), (m, b, off, s) => {
    const before = s.slice(Math.max(0, off - 12), off);
    const starts = off === 0 || /(?:^|\n)[ \t]*(?:(?:[-*+]|\d+\.)[ \t]+)?$/.test(before) || (/[.!?]\s+$/.test(before) && !ABBREV.test(before.replace(/[.!?]?\s+$/, "")));
    return starts ? b.toUpperCase() : b;
  });
  text = text.split(CUT).join("");
  text = text.replace(/\ba(?= (?:overall|advanced|essential|important|ongoing)\b)/gi, (m) => (m === "A" ? "An" : "an"));
  text = text.replace(/([^\s]) {2,}/g, "$1 ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return { text: restore(text, table), changes };
}

export const clean = (text) => (typeof text === "string" ? unslop(text).text : text);

// The writing rule Cairn adds to every session's starting context. Adapted from unslop's
// rules/unslop-activate.md (MIT); its mode switches and statusline aren't part of Cairn.
export const VOICE_RULE = [
  "Write like a careful human. Technical substance stays exact; only filler goes.",
  "- Drop: sycophancy (\"great question\", \"I'd be happy to\"), stock words (delve, tapestry, testament, seamless,",
  "  holistic, leverage, cutting-edge, crucial, pivotal), hedging stacks (\"it's important to note that\"),",
  "  stock openers (Furthermore, Moreover, In conclusion), padded lists of three, more than two em-dashes a paragraph.",
  "- Mix short and long sentences. No tidy five-paragraph essay shapes.",
  "- Keep: technical terms, quoted errors and code exact; honest uncertainty (\"probably\") when it is real.",
  "- Pattern: [what you saw]. [why it matters]. [what to do next].",
  "- Never invent facts to sound human. Code, commits and PRs are written normally.",
  "Cairn applies the same rules to the learnings, notices, threads, checkpoints and session messages it stores or",
  "passes on (CAIRN_UNSLOP=0 turns that off).",
].join("\n");
