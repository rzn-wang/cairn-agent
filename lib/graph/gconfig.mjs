// Graph settings: config.json `project.graph`, merged over these defaults (lib/config.mjs).
// The defaults are sized for large repos (100k+ files, 500k+ commits); small repos never reach the caps.

import { createHash } from "node:crypto";
import { merge, projectConfig } from "../config.mjs";

export const GRAPH_DEFAULTS = {
  enabled: true,
  exclude: [], // globs: kept out of the graph entirely
  include: [], // globs: indexed even when the default rules call them vendored or generated
  maxFileBytes: 512 * 1024,
  maxFiles: 400000,
  maxUntracked: 5000, // untracked files hashed per run; past this, the rest wait for a commit
  maxSymbolsPerFile: 64,
  symbols: "top-level", // "off" | "exported" | "top-level"
  references: "imports", // "off" | "imports"
  pythonRoots: [],
  includeDirs: [],
  pathAliases: {},
  cochange: {
    commits: 20000,
    days: 0, // 0: no date limit; the commit count bounds the walk and recency is weighted anyway
    maxFilesPerCommit: 50,
    halfLifeDays: 180,
    topK: 20,
    minSupport: 2,
    minWeight: 0.1,
    ignoreMessages: "^(chore\\(deps\\)|bump|format|prettier|lint|reformat|merge|revert \"?(format|lint))",
    commitNodes: 5000,
    // Files that change with everything say nothing about any one file: changelogs, version files, and any file
    // touched by more than `hubShare` of the commits read.
    ignore: ["**/CHANGELOG*", "**/CHANGES*", "**/HISTORY*", "**/History.md", "**/RELEASE*NOTES*", "**/VERSION", "**/version.txt"],
    hubShare: 0.2,
    minIntervalMin: 60, // a full recompute runs at most this often (detached updates)
  },
  query: {
    hops: 3,
    frontier: 64,
    fanout: 24,
    budgetMs: 40,
    graphCap: 1.34,
    graphScale: 1.5, // g·scale is compared with a direct citation (1); one strong co-change hop gives g ≈ 0.6
    beta: 0.75,
    weights: {},
  },
  coupling: { min: 0.5 },
  updateBudgetMs: 60000,
};

export function graphConfig(cwd) {
  return merge(GRAPH_DEFAULTS, projectConfig(cwd).graph || {});
}

// The settings that change what extraction or co-change produce; a change marks a rebuild of that part.
export function configHash(cfg) {
  const pick = { e: cfg.exclude, i: cfg.include, m: cfg.maxFileBytes, s: cfg.symbols, r: cfg.references, p: cfg.pythonRoots, d: cfg.includeDirs, a: cfg.pathAliases, n: cfg.maxSymbolsPerFile };
  return createHash("sha1").update(JSON.stringify(pick)).digest("hex").slice(0, 12);
}
export function cochangeHash(cfg) {
  return createHash("sha1").update(JSON.stringify(cfg.cochange)).digest("hex").slice(0, 12);
}
