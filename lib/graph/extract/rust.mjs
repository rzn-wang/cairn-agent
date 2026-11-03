// Rust. `use` trees are split into a path prefix (the spec) and the leaf names;
// `impl` blocks are not definitions of their own.

import { each } from "./common.mjs";

const VIS = String.raw`(?:pub(?:\s*\([^)]*\))?\s+)?`;
const RE_USE = new RegExp(`^[ \\t]*${VIS}use\\s+([^;]+);`, "gm");
const RE_MOD = new RegExp(`^[ \\t]*${VIS}mod\\s+(\\w+)\\s*;`, "gm");
const RE_EXTERN = /^[ \t]*extern\s+crate\s+(\w+)/gm;
const RE_ITEM = new RegExp(
  String.raw`^(pub(?:\s*\([^)]*\))?\s+)?(?:(?:default|async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*` +
    String.raw`(fn|struct|enum|trait|type|const|static|mod|union)\s+(?:mut\s+)?(\w+)`,
  "gm",
);
const RE_MACRO = /^(?:(#\[macro_export\])\s*)?macro_rules!\s*(\w+)/gm;
const KIND = { fn: "function", static: "var", mod: "module", union: "struct" };

// Leaf names of a use tree: `a::{b, c::d as e, f::*}` → ["b", "d", "*"].
function leaves(tree) {
  const out = [];
  for (let part of tree.split(/[{},]/)) {
    part = part.trim().split(/\s+as\s+/)[0].trim();
    if (!part) continue;
    const leaf = part.split("::").pop();
    if (leaf && leaf !== "self") out.push(leaf);
    else if (leaf === "self") out.push(part.split("::").slice(-2, -1)[0] || "self");
  }
  return out;
}

function parseUse(tree) {
  tree = tree.replace(/\s+/g, " ").trim().replace(/^::/, "");
  const brace = tree.indexOf("{");
  if (brace !== -1) {
    const spec = tree.slice(0, brace).replace(/::\s*$/, "");
    return { spec, names: leaves(tree.slice(brace)) };
  }
  const path = tree.split(/\s+as\s+/)[0].trim();
  if (path.endsWith("::*")) return { spec: path.slice(0, -3), names: ["*"] };
  return { spec: path, names: [path.split("::").pop()] };
}

export function extractRust(clean, lineOf) {
  const imports = [];
  each(clean, RE_USE, (m, i) => {
    const { spec, names } = parseUse(m[1]);
    if (spec) imports.push({ spec, kind: "use", names, line: lineOf(i) });
  });
  each(clean, RE_MOD, (m, i) => imports.push({ spec: m[1], kind: "mod", names: [], line: lineOf(i) }));
  each(clean, RE_EXTERN, (m, i) => imports.push({ spec: m[1], kind: "use", names: [], line: lineOf(i) }));
  imports.sort((a, b) => a.line - b.line);

  const symbols = [];
  each(clean, RE_ITEM, (m, i) => {
    // `mod x;` only points at a file (an import above); `mod x { }` defines one.
    if (m[2] === "mod" && /^\s*;/.test(clean.slice(i + m[0].length, i + m[0].length + 20))) return;
    symbols.push({ name: m[3], kind: KIND[m[2]] || m[2], line: lineOf(i), exported: !!m[1] });
  });
  each(clean, RE_MACRO, (m, i) => symbols.push({ name: m[2], kind: "macro", line: lineOf(i), exported: !!m[1] }));
  return { imports, symbols };
}
