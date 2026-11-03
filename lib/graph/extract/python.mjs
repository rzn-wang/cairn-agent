// Python. Imports may be indented (inside try/if/functions); symbols are column 0.

import { each, splitNames } from "./common.mjs";

const RE_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm;
const RE_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|(?:[^\n\\]|\\\n)*)/gm;
const RE_DEF = /^(?:async[ \t]+)?def[ \t]+(\w+)/gm;
const RE_CLASS = /^class[ \t]+(\w+)/gm;
const RE_CONST = /^([A-Z][A-Z0-9_]*)[ \t]*(?::[^=\n]*)?=(?!=)/gm;

export function extractPython(clean, lineOf) {
  const imports = [];
  each(clean, RE_IMPORT, (m, i) => {
    const line = lineOf(i);
    for (const spec of splitNames(m[1])) imports.push({ spec, kind: "import", names: [], line });
  });
  each(clean, RE_FROM, (m, i) => {
    const names = splitNames(m[2].replace(/#[^\n]*/g, ""));
    imports.push({ spec: m[1], kind: "import", names, line: lineOf(i) });
  });
  imports.sort((a, b) => a.line - b.line);

  const symbols = [];
  const sym = (name, kind, offset) => symbols.push({ name, kind, line: lineOf(offset), exported: !name.startsWith("_") });
  each(clean, RE_DEF, (m, i) => sym(m[1], "function", i));
  each(clean, RE_CLASS, (m, i) => sym(m[1], "class", i));
  each(clean, RE_CONST, (m, i) => sym(m[1], "const", i));
  return { imports, symbols };
}
