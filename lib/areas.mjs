// The area map from docs/AREAS.md, parsed from its "Area → owned paths" table so
// the doc stays the single source of truth. Used by the PostToolUse hook (first
// edit in an area → that area's doc and learnings) and by scripts/docs-check.mjs.
//
// Cell syntax it understands: backticked paths and globs (`*`, `**`, `.*`, a
// trailing `/` for a folder). A bare name after a path is its sibling, so
// `client/render/terrain.js` · `foliage.js` means client/render/foliage.js, and
// `tools/blender/` (`lib/`, …) means tools/blender/lib/. A name that exists at the
// repo root (`package.json`) stays there.

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

function toRegex(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  // A folder owns everything under it; a plain path also owns a folder of that name.
  if (pattern.endsWith("/")) return new RegExp(`^${re}`);
  return new RegExp(`^${re}(?:/.*)?$`);
}

function expandCell(root, cell) {
  const out = [];
  let dir = "";
  for (const [, raw] of cell.matchAll(/`([^`]+)`/g)) {
    const t = raw.trim();
    const head = t.split("/")[0].replace(/\*.*$/, "");
    const sibling = dir && !(existsSync(join(root, head)) && !existsSync(join(root, dir, head)));
    const path = sibling ? `${dir}/${t}` : t;
    if (!sibling) dir = t.endsWith("/") ? t.slice(0, -1) : posix.dirname(t);
    out.push({ pattern: path, re: toRegex(path), literal: path.replace(/\*.*$/, "").length });
  }
  return out;
}

// [{ name, patterns, docs: ["docs/…"], undocumented }] in table order.
export function readAreas(root) {
  const file = join(root, "docs", "AREAS.md");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const section = text.split(/^## /m).find((s) => s.startsWith("Area → owned paths")) || "";
  const areas = [];
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || !cells[1].startsWith("**")) continue;
    const name = cells[1].replace(/\*/g, "").trim();
    const docCell = cells[3];
    const docs = [...docCell.matchAll(/\]\(([^)]+)\)/g)].map((m) => posix.join("docs", m[1]));
    areas.push({
      name,
      patterns: expandCell(root, cells[2]),
      docs,
      undocumented: /not yet written up/i.test(docCell),
    });
  }
  return areas;
}

// The area owning a repo path: the most specific matching pattern wins (a named
// file beats its folder's glob); a tie goes to the earlier row.
export function areaOf(areas, path) {
  let best = null;
  let bestLen = -1;
  for (const a of areas) {
    for (const p of a.patterns) {
      if (p.literal > bestLen && p.re.test(path)) {
        best = a;
        bestLen = p.literal;
      }
    }
  }
  return best;
}
