// Ruby. Classes and modules nest inside namespace modules, so they count at any
// indent up to one level inside the enclosing modules; `def` only at column 0.

import { each } from "./common.mjs";

const RE_REQUIRE = /(^|[^\w.])(require_relative|require|load)\s*\(?\s*(["'])([^"'\n]+)\3/gm;
const RE_MODCLASS = /^([ \t]*)(class|module)[ \t]+([A-Z][\w:]*)/gm;
const RE_DEF = /^def[ \t]+(?:self\.)?([\w?!=]+)/gm;

export function extractRuby(clean, lineOf) {
  const imports = [];
  each(clean, RE_REQUIRE, (m, i) => {
    const imp = { spec: m[4], kind: "require", names: [], line: lineOf(i + m[1].length) };
    if (m[2] === "require_relative") imp.relative = true;
    else if (m[2] === "load") imp.load = true;
    imports.push(imp);
  });

  const symbols = [];
  const modIndents = []; // indents of `module` lines that are still open, roughly
  each(clean, RE_MODCLASS, (m, i) => {
    const w = m[1].replace(/\t/g, "  ").length;
    while (modIndents.length && modIndents[modIndents.length - 1] >= w) modIndents.pop();
    const allowed = modIndents.length ? modIndents[modIndents.length - 1] + 2 : 0;
    if (w > allowed) return;
    if (m[2] === "module") modIndents.push(w);
    symbols.push({ name: m[3], kind: m[2] === "module" ? "module" : "class", line: lineOf(i), exported: true });
  });
  each(clean, RE_DEF, (m, i) => symbols.push({ name: m[1], kind: "function", line: lineOf(i), exported: true }));
  return { imports, symbols };
}
