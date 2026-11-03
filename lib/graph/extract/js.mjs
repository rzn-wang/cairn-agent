// JavaScript / TypeScript (and the <script> blocks of .vue/.svelte). Imports are
// matched anywhere (they can sit inside functions or span lines); symbols only at
// column 0, which is where top-level declarations live in formatted code.

import { blank, each, splitNames } from "./common.mjs";

const B = String.raw`(^|[^\w$.])`; // not part of an identifier or member access
const STR = String.raw`(["'])([^"'\n]+)`;

const RE_FROM = new RegExp(`${B}import\\s+((?:type\\s+)?[\\w$*{}\\s,]+?)\\s*from\\s*${STR}\\3`, "g");
const RE_BARE = new RegExp(`${B}import\\s*${STR}\\2`, "g");
const RE_REEXPORT = new RegExp(
  `${B}export\\s+((?:type\\s+)?(?:\\*(?:\\s+as\\s+[\\w$]+)?|\\{[\\w$\\s,]*\\}))\\s*from\\s*${STR}\\3`,
  "g",
);
const RE_REQUIRE = new RegExp(`${B}require\\s*\\(\\s*${STR}\\2\\s*\\)`, "g");
const RE_DYNAMIC = new RegExp(`${B}import\\s*\\(\\s*(["'\`])([^"'\`\\n$]+)\\2\\s*\\)`, "g");

const ID = String.raw`[A-Za-z_$][\w$]*`;
const RE_FUNC = new RegExp(`^(export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:async\\s+)?function\\b\\s*\\*?\\s*(${ID})`, "gm");
const RE_CLASS = new RegExp(`^(export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})`, "gm");
const RE_VAR = new RegExp(`^(export\\s+)?(?:declare\\s+)?(const|let|var)\\s+(${ID})\\s*(?::[^=\\n]*)?=([^\\n]{0,80})`, "gm");
const RE_TYPE = new RegExp(`^(export\\s+)?(?:declare\\s+)?(?:const\\s+)?(interface|type|enum)\\s+(${ID})\\s*[<={]`, "gm");
const RE_NS = new RegExp(`^(export\\s+)?(?:declare\\s+)?(namespace|module)\\s+(${ID})\\s*\\{`, "gm");
const RE_EXPORT_DEFAULT = new RegExp(`^export\\s+default\\s+(${ID})\\s*;?\\s*$`, "gm");
const RE_EXPORT_LIST = /^export\s*\{([\w$\s,]*)\}\s*;?\s*$/gm;

// The clause between `import` and `from`: default, namespace and named parts.
function clauseNames(clause) {
  clause = clause.replace(/^type\s+/, "");
  const names = [];
  const brace = clause.match(/\{([^}]*)\}/);
  const rest = clause.replace(/\{[^}]*\}/, "").trim();
  if (/\*/.test(rest)) names.push("*");
  if (/^[A-Za-z_$][\w$]*/.test(rest) && !rest.startsWith("*")) names.push("default");
  if (brace) names.push(...splitNames(brace[1]));
  return names;
}

// .vue / .svelte: keep only the <script> blocks, blanking the rest in place.
export function scriptBlocks(text) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const bodyStart = m.index + m[1].length;
    out += blank(text.slice(last, bodyStart)) + m[2];
    last = bodyStart + m[2].length;
  }
  return out + blank(text.slice(last));
}

export function extractJs(clean, lineOf) {
  const imports = [];
  const add = (spec, kind, names, offset) => imports.push({ spec, kind, names, line: lineOf(offset) });
  each(clean, RE_FROM, (m, i) => add(m[4], "import", clauseNames(m[2]), i + m[1].length));
  each(clean, RE_BARE, (m, i) => add(m[3], "import", [], i + m[1].length));
  each(clean, RE_REEXPORT, (m, i) => {
    const brace = m[2].match(/\{([^}]*)\}/);
    add(m[4], "reexport", brace ? splitNames(brace[1]) : ["*"], i + m[1].length);
  });
  each(clean, RE_REQUIRE, (m, i) => add(m[3], "require", [], i + m[1].length));
  each(clean, RE_DYNAMIC, (m, i) => add(m[3], "dynamic", [], i + m[1].length));
  imports.sort((a, b) => a.line - b.line);

  const symbols = [];
  const sym = (name, kind, offset, exported) => symbols.push({ name, kind, line: lineOf(offset), exported: !!exported });
  each(clean, RE_FUNC, (m, i) => sym(m[2], "function", i, m[1]));
  each(clean, RE_CLASS, (m, i) => sym(m[2], "class", i, m[1]));
  each(clean, RE_VAR, (m, i) => {
    // `const debug = require("debug")` names an import, not a definition of this file.
    if (/^\s*(?:await\s+)?(?:require|import)\s*\(/.test(m[4])) return;
    const fn = /^\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*(?::[^=]*)?=>)/.test(m[4]);
    sym(m[3], fn ? "function" : m[2] === "const" ? "const" : "var", i, m[1]);
  });
  each(clean, RE_TYPE, (m, i) => sym(m[3], m[2], i, m[1]));
  each(clean, RE_NS, (m, i) => sym(m[3], "module", i, m[1]));
  // `export default X` / `export { a, b }` export existing names, not new ones.
  const late = new Set();
  each(clean, RE_EXPORT_DEFAULT, (m) => late.add(m[1]));
  each(clean, RE_EXPORT_LIST, (m) => splitNames(m[1]).forEach((n) => late.add(n)));
  for (const s of symbols) if (late.has(s.name)) s.exported = true;
  return { imports, symbols };
}
