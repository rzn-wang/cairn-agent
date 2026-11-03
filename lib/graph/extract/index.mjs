// Per-file extraction for the knowledge graph: imports, top-level symbols and
// (for docs) mentions, from plain regex passes over comment-stripped text.
// Pure and total — any surprise yields empty arrays, never a throw.

import { finishSymbols, lineIndex, stripComments } from "./common.mjs";
import { extractCfamily } from "./cfamily.mjs";
import { extractCsharp } from "./csharp.mjs";
import { extractGo } from "./go.mjs";
import { extractJs, scriptBlocks } from "./js.mjs";
import { extractJvm } from "./jvm.mjs";
import { extractMarkdown } from "./markdown.mjs";
import { extractPhp } from "./php.mjs";
import { extractPython } from "./python.mjs";
import { extractRuby } from "./ruby.mjs";
import { extractRust } from "./rust.mjs";

const LANG = {};
const langs = {
  js: "js jsx ts tsx mjs cjs mts cts vue svelte",
  python: "py pyi",
  go: "go",
  rust: "rs",
  jvm: "java kt kts scala",
  csharp: "cs",
  cfamily: "c h cc cpp cxx hpp hh hxx m mm",
  ruby: "rb",
  php: "php",
  markdown: "md mdx rst adoc",
};
for (const [lang, exts] of Object.entries(langs)) for (const e of exts.split(" ")) LANG[e] = lang;

const EXTRACT = {
  js: extractJs,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  jvm: extractJvm,
  csharp: extractCsharp,
  cfamily: extractCfamily,
  ruby: extractRuby,
  php: extractPhp,
  markdown: extractMarkdown,
};

export function langOf(path) {
  const base = String(path || "").split("/").pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANG[base.slice(dot + 1).toLowerCase()] || null;
}

export function extract(text, path, { maxSymbols = 64 } = {}) {
  const empty = { imports: [], symbols: [], mentions: [] };
  try {
    const lang = langOf(path);
    if (!lang || typeof text !== "string" || !text) return empty;
    if (/\.(vue|svelte)$/i.test(path)) text = scriptBlocks(text);
    const clean = stripComments(text.replace(/\r\n?/g, (m) => (m.length === 2 ? " \n" : "\n")), lang);
    const { starts, lineOf } = lineIndex(clean);
    const out = EXTRACT[lang](clean, lineOf);
    return {
      imports: out.imports || [],
      symbols: finishSymbols(out.symbols || [], clean, starts, maxSymbols),
      mentions: out.mentions || [],
    };
  } catch {
    return empty;
  }
}
