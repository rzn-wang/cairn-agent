// Java, Kotlin, Scala. Top-level types sit at column 0 in all three; Kotlin and
// Scala drop the semicolons and Scala imports can group leaves in braces.

import { each, splitNames } from "./common.mjs";

const RE_PACKAGE = /^[ \t]*package\s+([\w.]+)/m;
const RE_IMPORT = /^[ \t]*import\s+(static\s+)?([\w.]+?)(\.\*|\._|\.\{[^}]*\})?(?:\s+as\s+\w+)?[ \t]*;?[ \t]*$/gm;
const MODS =
  "public|private|protected|internal|abstract|final|sealed|open|data|inline|value|enum|annotation|static|" +
  "strictfp|case|implicit|lazy|override|suspend|tailrec|operator|infix|external|expect|actual|non-sealed|const";
const RE_DECL = new RegExp(
  `^((?:(?:${MODS})\\s+)*)(class|interface|enum|record|object|fun|trait|typealias|@interface|val|var)\\s+` +
    String.raw`(?:<[^>\n]*>\s*)?(?:[\w.]+\.)?(\w+)`,
  "gm",
);
const KIND = { record: "class", object: "class", "@interface": "interface", fun: "function", typealias: "type", val: "const" };

export function extractJvm(clean, lineOf) {
  const imports = [];
  const pkg = clean.match(RE_PACKAGE);
  if (pkg) imports.push({ spec: pkg[1], kind: "package", names: [], line: lineOf(pkg.index) });
  each(clean, RE_IMPORT, (m, i) => {
    const line = lineOf(i);
    const tail = m[3] || "";
    const imp = { spec: m[2], kind: "import", names: [], line };
    if (tail === ".*" || tail === "._") Object.assign(imp, { spec: `${m[2]}.*`, names: ["*"] });
    else if (tail) imp.names = splitNames(tail.slice(2, -1), "=>");
    else imp.names = [m[2].split(".").pop()];
    if (m[1]) imp.static = true;
    imports.push(imp);
  });

  const symbols = [];
  each(clean, RE_DECL, (m, i) => {
    const mods = m[1] || "";
    let kind = KIND[m[2]] || m[2];
    if (/\benum\b/.test(mods)) kind = "enum";
    if (/\bannotation\b/.test(mods)) kind = "interface";
    symbols.push({ name: m[3], kind, line: lineOf(i), exported: !/\bprivate\b/.test(mods) });
  });
  return { imports, symbols };
}
