// C#. Types live one level inside `namespace X { }` (or at column 0 with a
// file-scoped `namespace X;`), so the allowed indent depends on which form the file uses.

import { each } from "./common.mjs";

const RE_USING = /^[ \t]*(?:global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/gm;
const RE_NAMESPACE = /^[ \t]*namespace\s+([\w.]+)\s*([;{]?)/gm;
const MODS = "public|internal|private|protected|static|partial|sealed|abstract|readonly|unsafe|new|file|ref";
const RE_TYPE = new RegExp(
  `^([ \\t]*)((?:(?:${MODS})\\s+)*)(class|struct|interface|enum|record(?:\\s+struct|\\s+class)?)\\s+(\\w+)`,
  "gm",
);
const RE_DELEGATE = new RegExp(`^([ \\t]*)((?:(?:${MODS})\\s+)*)delegate\\s+[^;(]*?\\s(\\w+)\\s*[<(]`, "gm");

function width(indent) {
  return indent.replace(/\t/g, "    ").length;
}

export function extractCsharp(clean, lineOf) {
  const imports = [];
  let blockNs = false;
  each(clean, RE_NAMESPACE, (m, i) => {
    imports.push({ spec: m[1], kind: "package", names: [], line: lineOf(i) });
    if (m[2] !== ";") blockNs = true;
  });
  each(clean, RE_USING, (m, i) => {
    const imp = { spec: m[3], kind: "use", names: m[2] ? [m[2]] : [], line: lineOf(i) };
    if (m[1]) imp.static = true;
    imports.push(imp);
  });
  imports.sort((a, b) => a.line - b.line);

  const max = blockNs ? 4 : 0;
  const symbols = [];
  const sym = (indent, mods, name, kind, offset) => {
    if (width(indent) > max) return;
    symbols.push({ name, kind, line: lineOf(offset), exported: !/\b(private|file)\b/.test(mods) });
  };
  each(clean, RE_TYPE, (m, i) => sym(m[1], m[2], m[4], m[3].startsWith("record") ? (/struct/.test(m[3]) ? "struct" : "class") : m[3], i));
  each(clean, RE_DELEGATE, (m, i) => sym(m[1], m[2], m[3], "type", i));
  return { imports, symbols };
}
