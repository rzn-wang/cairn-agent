// Go. gofmt puts every top-level declaration at column 0, so the regexes can be
// strict about that.

import { each } from "./common.mjs";

const RE_PACKAGE = /^package[ \t]+(\w+)/m;
const RE_IMPORT = /^import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/gm;
const RE_IMPORT_GROUP = /^import[ \t]*\(([^)]*)\)/gm;
const RE_GROUP_LINE = /^[ \t]*(?:[\w.]+[ \t]+)?"([^"]+)"/gm;
const RE_FUNC = /^func[ \t]+(\w+)/gm;
const RE_METHOD = /^func[ \t]*\(\s*(?:\w+\s+)?\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*(\w+)/gm;
const RE_TYPE = /^type[ \t]+(\w+)(?:\[[^\]]*\])?[ \t]+(struct|interface)?/gm;
const RE_VAR = /^(var|const)[ \t]+(\w+)/gm;
const RE_GROUP = /^(var|const|type)[ \t]*\(\n([\s\S]*?)^\)/gm;

const exported = (name) => /^[A-Z]/.test(name);

export function extractGo(clean, lineOf) {
  const imports = [];
  const pkg = clean.match(RE_PACKAGE);
  if (pkg) imports.push({ spec: pkg[1], kind: "package", names: [], line: lineOf(pkg.index) });
  each(clean, RE_IMPORT, (m, i) => imports.push({ spec: m[1], kind: "import", names: [], line: lineOf(i) }));
  each(clean, RE_IMPORT_GROUP, (m, i) => {
    const bodyAt = i + m[0].indexOf("(") + 1;
    each(m[1], RE_GROUP_LINE, (g, j) =>
      imports.push({ spec: g[1], kind: "import", names: [], line: lineOf(bodyAt + j) }),
    );
  });
  imports.sort((a, b) => a.line - b.line);

  const symbols = [];
  const sym = (name, kind, offset, exp = exported(name)) => symbols.push({ name, kind, line: lineOf(offset), exported: exp });
  each(clean, RE_FUNC, (m, i) => sym(m[1], "function", i));
  each(clean, RE_METHOD, (m, i) => sym(`${m[1]}.${m[2]}`, "method", i, exported(m[2])));
  each(clean, RE_TYPE, (m, i) => sym(m[1], m[2] || "type", i));
  each(clean, RE_VAR, (m, i) => sym(m[2], m[1] === "const" ? "const" : "var", i));
  each(clean, RE_GROUP, (m, i) => {
    const bodyAt = i + m[0].indexOf("\n") + 1;
    // Only lines at the group's own indent name things; deeper ones are struct bodies etc.
    const indent = (m[2].match(/^[ \t]+(?=\w)/m) || [""])[0];
    const re = new RegExp(`^${indent}(\\w+)`, "gm");
    each(m[2], re, (g, j) => {
      if (m[1] === "type") {
        const kind = (m[2].slice(j).match(/^\s*\w+\s+(struct|interface)?/) || [])[1];
        sym(g[1], kind || "type", bodyAt + j);
      } else sym(g[1], m[1] === "const" ? "const" : "var", bodyAt + j);
    });
  });
  return { imports, symbols };
}
