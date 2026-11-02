// C, C++, Objective-C. Type definitions must open a body (`{` or a base-class
// `:`) so forward declarations don't count; function definitions are found line
// by line with a short look-ahead for the `{`, which keeps the regex linear.

import { each } from "./common.mjs";

const RE_INCLUDE = /^[ \t]*#[ \t]*(?:include|import)[ \t]*([<"])([^>"\n]+)[>"]/gm;
const RE_TYPE =
  /^(?:template\s*<[^>]*>\s*)?(?:typedef\s+)?(class|struct|enum(?:\s+class|\s+struct)?|union|namespace)\s+(?:\w+\s+)*?(\w+)\s*(?:final\s*)?(?:[{]|:(?!:))/gm;
const RE_TYPEDEF = /^typedef\b([^;{]*);/gm;
const RE_TYPEDEF_BODY = /^typedef\s+(?:struct|union|enum)\b[^;{]*\{/gm;
const RE_DEFINE = /^[ \t]*#[ \t]*define[ \t]+(\w+)([^\n]*)/gm;
const RE_FN_LINE = /^(?:[A-Za-z_~][^\n;#]*?)?\b(~?[A-Za-z_][\w:~]*)[ \t]*\(/gm;
const NOT_FN = new Set("if for while switch return else do sizeof case catch defined typedef using new delete".split(" "));
const KIND = { union: "struct", namespace: "module" };

export function extractCfamily(clean, lineOf) {
  const imports = [];
  each(clean, RE_INCLUDE, (m, i) =>
    imports.push({ spec: m[2], kind: "include", names: m[1] === "<" ? ["system"] : [], line: lineOf(i) }),
  );

  const symbols = [];
  const sym = (name, kind, offset, exported = true) => symbols.push({ name, kind, line: lineOf(offset), exported });
  each(clean, RE_TYPE, (m, i) => sym(m[2], KIND[m[1]] || m[1].split(/\s+/)[0], i));
  each(clean, RE_TYPEDEF, (m, i) => {
    const fp = m[1].match(/\(\s*\*\s*(\w+)\s*\)/);
    const name = fp ? fp[1] : (m[1].match(/(\w+)\s*(?:\[[^\]]*\])*\s*$/) || [])[1];
    if (name) sym(name, "type", i);
  });
  each(clean, RE_TYPEDEF_BODY, (m, i) => {
    const close = /^\}\s*\*?\s*(\w+)/m.exec(clean.slice(i, i + 65536));
    if (close) sym(close[1], "type", i);
  });
  each(clean, RE_DEFINE, (m, i) => {
    // Include guards (`#define FOO_H` with no value) aren't worth a symbol.
    if (!m[2].trim() && /_H(PP)?_?$/.test(m[1])) return;
    sym(m[1], "macro", i);
  });
  each(clean, RE_FN_LINE, (m, i) => {
    if (NOT_FN.has(m[1]) || m[0].length > 300) return;
    const head = m[0].slice(0, m[0].length - m[1].length).trim();
    if (/^(return|else|case|goto|typedef|using)\b|[=,]/.test(head)) return;
    // The parameter list and an opening brace within a few lines, no `;` between.
    const ahead = clean.slice(i + m[0].length, i + m[0].length + 600);
    const close = ahead.match(/^(?:[^();{}]|\([^();{}]*\))*\)\s*(?:const\s*|noexcept\s*|override\s*|final\s*|->\s*[\w:<>*& ]+)*(?::[^;{]*)?\{/);
    if (!close) return;
    // K&R style puts the return type on the line before; a bare call at col 0 has none.
    if (!head && !/\w[\w*&\s]*\n$/.test(clean.slice(Math.max(0, i - 120), i))) return;
    sym(m[1], m[1].includes("::") ? "method" : "function", i, !/^static\b/.test(head));
  });
  return { imports, symbols };
}
