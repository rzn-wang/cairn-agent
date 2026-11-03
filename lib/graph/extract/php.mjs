// PHP. Declarations sit at column 0, or one level in with braced
// `namespace X { }`; `use` inside a class body (traits) is still a dependency.

import { each, splitNames } from "./common.mjs";

const RE_NAMESPACE = /^[ \t]*namespace\s+([\w\\]+)\s*([;{])/gm;
const RE_USE = /^[ \t]*use\s+(?:function\s+|const\s+)?([\w\\]+?)(?:\\\{([^}]*)\})?((?:\s+as\s+\w+)?(?:\s*,\s*[\w\\]+(?:\s+as\s+\w+)?)*)\s*;/gm;
const RE_REQUIRE = /(^|[^\w$>:])(?:require|include)(?:_once)?\s*\(?\s*(__DIR__\s*\.\s*)?(["'])([^"'\n]+)\3/gm;
const RE_DECL = /^([ \t]*)((?:(?:abstract|final|readonly)\s+)*)(class|interface|trait|enum|function)\s+&?(\w+)/gm;

export function extractPhp(clean, lineOf) {
  const imports = [];
  let braced = false;
  each(clean, RE_NAMESPACE, (m, i) => {
    imports.push({ spec: m[1].replace(/^\\/, ""), kind: "package", names: [], line: lineOf(i) });
    if (m[2] === "{") braced = true;
  });
  each(clean, RE_USE, (m, i) => {
    const line = lineOf(i);
    const head = m[1].replace(/^\\/, "");
    if (m[2] !== undefined) {
      imports.push({ spec: head, kind: "use", names: splitNames(m[2]), line });
      return;
    }
    for (const spec of [head, ...splitNames(m[3].replace(/^\s*as\s+\w+/, ""))]) {
      const s = spec.replace(/^\\/, "");
      imports.push({ spec: s, kind: "use", names: [s.split("\\").pop()], line });
    }
  });
  each(clean, RE_REQUIRE, (m, i) => {
    let spec = m[4];
    // __DIR__ . '/x.php' is relative to this file.
    if (m[2] && spec.startsWith("/")) spec = `.${spec}`;
    imports.push({ spec, kind: "require", names: [], line: lineOf(i + m[1].length) });
  });
  imports.sort((a, b) => a.line - b.line);

  const max = braced ? 4 : 0;
  const symbols = [];
  each(clean, RE_DECL, (m, i) => {
    if (m[1].replace(/\t/g, "    ").length > max) return;
    symbols.push({ name: m[4], kind: m[3], line: lineOf(i), exported: true });
  });
  return { imports, symbols };
}
