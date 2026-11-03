// Symbol baselines for learnings: when a fact cites `src/a.ts#Widget` (or names `Widget` in backticks while citing
// src/a.ts), the symbol's definition hashes are recorded with it. Later the graph can tell "Widget was renamed to
// Gadget" or "Widget is gone" apart from "src/a.ts changed", which says nothing about one sentence describing it
// (the 2026-10-06 lesson: flagging every changed file flagged 84% of facts). A changed body alone never flags.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLAG, KIND } from "./schema.mjs";

const require = createRequire(import.meta.url);
let X; // the extractors, loaded on first use (synchronously: Node 22.12+ can require an ES module)
function extractor() {
  if (X === undefined) {
    try {
      X = require("./extract/index.mjs");
    } catch {
      X = null;
    }
  }
  return X;
}

// { "path#Name": "<hash>|<hash2>" } for the symbol refs and backticked names a learning carries.
export function symbolBaselines(root, refs = [], text = "") {
  const ex = extractor();
  if (!ex) return {};
  const out = {};
  const symsOf = new Map();
  const load = (path) => {
    if (!symsOf.has(path)) {
      let syms = [];
      try {
        if (ex.langOf(path)) syms = ex.extract(readFileSync(join(root, path), "utf8"), path, { maxSymbols: 500 }).symbols || [];
      } catch {
        syms = [];
      }
      symsOf.set(path, new Map(syms.map((s) => [s.name, s])));
    }
    return symsOf.get(path);
  };
  const plain = [];
  for (const ref of refs) {
    const [path, name] = String(ref).split("#");
    if (name) {
      const s = load(path).get(name);
      if (s) out[`${path}#${name}`] = `${s.hash}|${s.hash2}`;
    } else plain.push(path);
  }
  const named = [...String(text).matchAll(/`([A-Za-z_$][\w$.:]*)(?:\(\))?`/g)].map((m) => m[1]);
  for (const path of plain)
    for (const n of named) {
      const s = load(path).get(n);
      if (s) out[`${path}#${n}`] = `${s.hash}|${s.hash2}`;
    }
  return out;
}

// Flag learnings whose cited symbol was removed, renamed or moved (graph lookup; no file reads).
export function symbolStaleness(db, rows) {
  const fileQ = db.prepare("SELECT id, flags FROM node WHERE kind=? AND key=?");
  const inFile = db.prepare("SELECT name, hash2 FROM node WHERE kind=? AND file_id=? AND name=?");
  const sameBodyInFile = db.prepare("SELECT name FROM node WHERE kind=4 AND hash2=?2 AND file_id=?1 LIMIT 1");
  const sameBodyAnywhere = db.prepare(
    "SELECT s.name AS name, f.key AS path FROM node s JOIN node f ON f.id = s.file_id WHERE s.kind=4 AND s.hash2=? LIMIT 1",
  );
  for (const l of rows) {
    const reasons = [];
    for (const [ref, base] of Object.entries(l.sym_refs || {})) {
      const [path, name] = ref.split("#");
      const [, hash2] = String(base).split("|");
      const f = fileQ.get(KIND.file, path);
      if (!f || f.flags & FLAG.deleted) continue; // a deleted file is the existence check's job
      if (inFile.get(KIND.symbol, f.id, name)) continue;
      const renamed = hash2 && sameBodyInFile.get(f.id, hash2);
      if (renamed) {
        reasons.push(`\`${name}\` renamed to \`${renamed.name}\` in ${path}`);
        continue;
      }
      const moved = hash2 && sameBodyAnywhere.get(hash2);
      if (moved) reasons.push(`\`${name}\` moved to ${moved.path}${moved.name !== name ? ` as \`${moved.name}\`` : ""}`);
      else reasons.push(`\`${name}\` is no longer defined in ${path}`);
    }
    if (reasons.length) {
      l.stale = true;
      l.stale_reason = reasons.slice(0, 2).join("; ");
    }
  }
  return rows;
}

