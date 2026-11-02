// Code structure: which files exist, what each imports and defines, which tests and docs point at which files.
// Three steps, all incremental:
//   inventory  - git's file list against the stored blob ids: new, changed, deleted
//   extract    - read only the changed files; keep their symbols (ids stable by name) and raw import specifiers
//   resolve    - turn specifiers into edges, for changed files and for files whose imports pointed at something
//                that appeared or disappeared, without re-reading them

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compileGlobs, classifyPath, hashFile, linguistAttrs, listFiles, sniff } from "./inventory.mjs";
import { resolveMention } from "./memory.mjs";
import { EDGE, FLAG, KIND, ROLE, identWords } from "./schema.mjs";

const EXTRACTABLE = new Set([ROLE.src, ROLE.test, ROLE.doc, ROLE.config]);
const MAX_CONTAINS = 2000;

let extractMod = null;
let resolveMod = null;
// The extractors and resolver load lazily, so co-change and memory work even where they can't.
export async function loadExtractors() {
  if (extractMod === null) {
    try {
      extractMod = await import("./extract/index.mjs");
      resolveMod = await import("./resolve.mjs");
    } catch {
      extractMod = false;
      resolveMod = false;
    }
  }
  return extractMod ? { ...extractMod, ...resolveMod } : null;
}

function dirsOf(path) {
  const parts = path.split("/");
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

// Step 1. Returns { toExtract: [{ id, path, role, sha }], deleted: [id], added, total, roles }.
export function inventory(db, w, root, cfg, { onProgress } = {}) {
  const { files } = listFiles(root, { maxUntracked: cfg.maxUntracked });
  let paths = [...files.keys()];
  if (paths.length > cfg.maxFiles) paths = paths.slice(0, cfg.maxFiles);
  const exclude = compileGlobs(cfg.exclude);
  const include = compileGlobs(cfg.include);

  const existing = new Map();
  for (const r of db.prepare("SELECT id, key, hash, role, flags, data FROM node WHERE kind=?").all(KIND.file)) existing.set(r.key, r);
  const stamps = new Map(); // untracked/modified files: { size, mtimeMs } to store, so the next run needn't re-read them
  // Only new and changed files are classified (and asked about .gitattributes); unchanged ones keep their role.
  const shas = new Map();
  const todo = [];
  for (const path of paths) {
    const f = files.get(path);
    const prev = existing.get(path);
    let sha = f.sha;
    if (!sha) {
      let known = null;
      try {
        known = prev?.data ? JSON.parse(prev.data).stamp || null : null; // { size, mtimeMs, sha }: its own hash, not the indexed one
      } catch {
        known = null;
      }
      const h = hashFile(root, path, cfg.maxFileBytes, known);
      sha = h.sha;
      if (sha && h.mtimeMs) stamps.set(path, { size: h.size, mtimeMs: h.mtimeMs, sha });
    }
    shas.set(path, sha);
    if (!(prev && sha && prev.hash === sha && !(prev.flags & FLAG.deleted))) todo.push(path);
  }
  const attrs = todo.length && paths.some((p) => p === ".gitattributes" || p.endsWith("/.gitattributes")) ? linguistAttrs(root, todo) : null;

  const toExtract = [];
  const roles = {};
  let added = 0;
  const listed = new Set();
  const dirIds = new Map(db.prepare("SELECT key, id FROM node WHERE kind=?").all(KIND.dir).map((r) => [r.key, r.id]));
  const dirKids = new Map();
  const ensureDir = (d) => {
    if (dirIds.has(d)) return dirIds.get(d);
    const base = d.split("/").pop();
    const id = w.node(KIND.dir, d, { name: base });
    w.st.ftsIdent.run(identWords(d), id);
    dirIds.set(d, id);
    const parent = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : null;
    if (parent) w.edge(ensureDir(parent), EDGE.contains, id, 1);
    return id;
  };
  const insFile = db.prepare(
    "INSERT INTO node(kind,key,name,lname,role,flags) VALUES(1,?,?,?,?,0) ON CONFLICT(kind,key) DO UPDATE SET role=excluded.role, flags=0 RETURNING id",
  );
  const setHash = db.prepare("UPDATE node SET hash=?, role=?, flags=0 WHERE id=?");
  const setStamp = db.prepare("UPDATE node SET data=? WHERE id=?");

  db.exec("BEGIN IMMEDIATE");
  try {
    let i = 0;
    for (const path of paths) {
      if (onProgress && ++i % 20000 === 0) onProgress(i, paths.length);
      listed.add(path);
      const sha = shas.get(path);
      if (!sha) continue; // vanished between listing and hashing
      const prev = existing.get(path);
      if (prev && prev.hash === sha && !(prev.flags & FLAG.deleted)) {
        roles[prev.role] = (roles[prev.role] || 0) + 1;
        w.fileIds.set(path, prev.id);
        if (stamps.has(path)) setStamp.run(JSON.stringify({ stamp: stamps.get(path) }), prev.id);
        continue;
      }
      const role = classifyPath(path, { exclude, include, attrs });
      roles[role] = (roles[role] || 0) + 1;
      let id = prev?.id;
      if (!prev || prev.flags & FLAG.deleted) {
        const base = path.split("/").pop();
        id = insFile.get(path, base, base.toLowerCase(), role).id;
        w.st.ftsIdentDel.run(id);
        w.st.ftsIdent.run(identWords(path), id);
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
        if (parent) {
          const n = (dirKids.get(parent) || 0) + 1;
          dirKids.set(parent, n);
          if (n <= MAX_CONTAINS) w.edge(ensureDir(parent), EDGE.contains, id, 1);
        }
        added++;
      }
      w.fileIds.set(path, id);
      setStamp.run(stamps.has(path) ? JSON.stringify({ stamp: stamps.get(path) }) : null, id);
      // (Unchanged content was skipped above. Roles follow content: extraction may refine a path's role to
      // binary, generated or too big, and a settings change clears every hash anyway.)
      if (EXTRACTABLE.has(role)) toExtract.push({ id, path, role, sha });
      else setHash.run(sha, role, id);
    }
    // Files gone from the tree: keep the node (memory may cite it) but drop what it said about the code.
    const deleted = [];
    for (const [path, r] of existing) {
      if (listed.has(path) || r.flags & FLAG.deleted) continue;
      deleted.push(r.id);
      w.fileIds.set(path, r.id);
    }
    db.exec("COMMIT");
    return { toExtract, deleted, added, total: paths.length, roles };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Importers of the given files (by edges their extraction produced), for re-resolution.
function importersOf(db, ids) {
  const out = new Set();
  const q = db.prepare("SELECT DISTINCT origin FROM edge WHERE dst=? AND type IN (?,?,?) AND origin IS NOT NULL");
  for (const id of ids) for (const r of q.all(id, EDGE.imports, EDGE.references, EDGE.documents)) out.add(r.origin);
  return out;
}

export function markDeleted(db, w, ids) {
  if (!ids.length) return new Set();
  const importers = importersOf(db, ids);
  const delOrigin = db.prepare("DELETE FROM edge WHERE origin=?");
  const syms = db.prepare("SELECT id FROM node WHERE file_id=?");
  const delSpec = db.prepare("DELETE FROM spec WHERE file_id=?");
  const flag = db.prepare("UPDATE node SET flags=flags|?, hash=NULL, churn=NULL WHERE id=?");
  const delIn = db.prepare("DELETE FROM edge WHERE dst=? AND type IN (?,?,?,?,?)");
  const delOut = db.prepare("DELETE FROM edge WHERE src=? AND type IN (?,?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of ids) {
      delOrigin.run(id);
      for (const s of syms.all(id)) w.remove(s.id);
      delSpec.run(id);
      delIn.run(id, EDGE.contains, EDGE.imports, EDGE.co_changed, EDGE.tests, EDGE.documents);
      delOut.run(id, EDGE.co_changed, EDGE.tests);
      flag.run(FLAG.deleted, id);
      importers.delete(id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return importers;
}

// Step 2. Reads and extracts `items` in chunks until `deadline`. Returns { done: [id], rest }.
export async function extractFiles(db, w, root, items, cfg, { deadline = Infinity, chunk = 500, onProgress } = {}) {
  const X = await loadExtractors();
  const setFile = db.prepare("UPDATE node SET hash=?, role=?, lang=?, flags=0 WHERE id=?");
  const delOrigin = db.prepare("DELETE FROM edge WHERE origin=?");
  const delSpec = db.prepare("DELETE FROM spec WHERE file_id=?");
  const insSpec = db.prepare("INSERT OR IGNORE INTO spec(file_id, spec, kind, names, resolved) VALUES(?,?,?,?,NULL)");
  const oldSyms = db.prepare("SELECT id, name FROM node WHERE kind=? AND file_id=?");
  const done = [];
  let i = 0;
  for (; i < items.length; i += chunk) {
    if (Date.now() > deadline) break;
    const batch = items.slice(i, i + chunk);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const it of batch) {
        let role = it.role;
        let lang = null;
        let text = null;
        try {
          const st = statSync(join(root, it.path));
          if (st.size > cfg.maxFileBytes) role = ROLE.too_big;
        } catch {
          continue; // gone: the next inventory marks it deleted
        }
        if (role !== ROLE.too_big) {
          const sniffed = sniff(root, it.path);
          if (sniffed !== null && !(sniffed === ROLE.generated && it.role === ROLE.doc)) role = sniffed;
        }
        delOrigin.run(it.id);
        delSpec.run(it.id);
        const keep = new Set();
        if (EXTRACTABLE.has(role) && X) {
          lang = X.langOf(it.path);
          if (lang) {
            try {
              text = readFileSync(join(root, it.path), "utf8");
            } catch {
              text = null;
            }
          }
          if (text !== null) {
            const res = X.extract(text, it.path, { maxSymbols: cfg.maxSymbolsPerFile });
            if (cfg.symbols !== "off") {
              for (const s of res.symbols || []) {
                if (cfg.symbols === "exported" && !s.exported) continue;
                if (keep.has(s.name)) continue;
                keep.add(s.name);
                const sid = w.node(KIND.symbol, `${it.id}#${s.name}`, {
                  name: s.name,
                  file_id: it.id,
                  lang,
                  hash: s.hash,
                  hash2: s.hash2,
                  line: s.line,
                  flags: s.exported ? FLAG.exported : 0,
                  data: s.kind ? { kind: s.kind } : undefined,
                });
                w.st.ftsIdentDel.run(sid);
                w.st.ftsIdent.run(identWords(s.name), sid);
              }
            }
            for (const imp of res.imports || []) insSpec.run(it.id, String(imp.spec).slice(0, 500), imp.kind, (imp.names || []).length ? JSON.stringify(imp.names.slice(0, 50)) : null);
            for (const m of res.mentions || []) insSpec.run(it.id, String(m.text).slice(0, 300), m.kind === "ident" ? "mention-ident" : "mention-path", null);
          }
        }
        for (const s of oldSyms.all(KIND.symbol, it.id)) if (!keep.has(s.name)) w.remove(s.id);
        setFile.run(it.sha, role, lang, it.id);
        done.push(it.id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    if (onProgress) onProgress(Math.min(i + chunk, items.length), items.length);
    await new Promise((r) => setImmediate(r));
  }
  return { done, rest: items.length - Math.min(i, items.length) };
}

// Step 3. Re-resolve every specifier of `fileIds` (and of files with nothing resolved, when files came or went).
export async function resolveFiles(db, w, root, fileIds, cfg, { includeUnresolved = false } = {}) {
  const X = await loadExtractors();
  if (!X) return { files: 0, edges: 0, unresolved: 0 };
  const live = db.prepare("SELECT id, key, role, lang FROM node WHERE kind=? AND (flags & ?) = 0").all(KIND.file, FLAG.deleted);
  const byId = new Map(live.map((r) => [r.id, r]));
  const paths = live.map((r) => r.key);
  for (const r of live) w.fileIds.set(r.key, r.id);
  const packages = db
    .prepare("SELECT n.key AS path, n.lang AS lang, s.spec AS pkg FROM spec s JOIN node n ON n.id = s.file_id WHERE s.kind = 'package'")
    .all();
  // Top-level names per declaring file make Java/Kotlin/C#/PHP lookups exact rather than guessed from file names.
  const namesOf = db.prepare("SELECT name FROM node WHERE kind=? AND file_id=(SELECT id FROM node WHERE kind=1 AND key=?)");
  for (const p of packages) p.symbols = namesOf.all(KIND.symbol, p.path).map((r) => r.name);
  const resolver = X.buildResolver(root, paths, { pathAliases: cfg.pathAliases, pythonRoots: cfg.pythonRoots, includeDirs: cfg.includeDirs, packages });
  const targets = new Set(fileIds);
  if (includeUnresolved)
    for (const r of db.prepare("SELECT DISTINCT file_id FROM spec WHERE (resolved IS NULL OR resolved = 0) AND kind NOT IN ('package')").all()) targets.add(r.file_id);

  const specsOf = db.prepare("SELECT spec, kind, names FROM spec WHERE file_id=?");
  const setRes = db.prepare("UPDATE spec SET resolved=? WHERE file_id=? AND spec=? AND kind=?");
  const delOrigin = db.prepare("DELETE FROM edge WHERE origin=?");
  const symIn = db.prepare("SELECT id FROM node WHERE kind=? AND file_id=? AND name=?");
  const moduleNode = (key) => w.node(KIND.module, key, { name: key.replace(/^(?:ext:\w+:|ws:)/, "") });
  let edges = 0;
  let unresolved = 0;
  const ids = [...targets].filter((id) => byId.has(id));
  for (let i = 0; i < ids.length; i += 1000) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids.slice(i, i + 1000)) {
        const f = byId.get(id);
        delOrigin.run(id);
        const isTest = f.role === ROLE.test;
        const isDoc = f.role === ROLE.doc;
        let n = 0;
        const imported = new Set();
        for (const s of specsOf.all(id)) {
          if (s.kind === "package") {
            setRes.run(-1, id, s.spec, s.kind);
            continue;
          }
          let count = 0;
          if (s.kind === "mention-path") {
            const t = resolveMention(w, s.spec);
            if (t && t !== id) w.edge(id, isDoc ? EDGE.documents : EDGE.mentions, t, 0.8, id), count++;
          } else if (s.kind === "mention-ident") {
            const hits = w.st.byName.all(KIND.symbol, s.spec.split(".").pop().toLowerCase());
            if (hits.length === 1) w.edge(id, EDGE.mentions, hits[0].id, 0.8, id), count++;
          } else {
            const names = s.names ? JSON.parse(s.names) : [];
            let results = [];
            try {
              results = resolver.resolve(f.key, { spec: s.spec, kind: s.kind, names }, f.lang) || [];
            } catch {
              results = [];
            }
            for (const r of results) {
              if (r.path) {
                const t = w.fileIds.get(r.path);
                if (!t || t === id) continue;
                const wt = r.w ?? 1;
                if (s.kind === "link") w.edge(id, EDGE.documents, t, wt, id);
                else {
                  w.edge(id, EDGE.imports, t, wt, id);
                  imported.add(r.path);
                  if (isTest) w.edge(id, EDGE.tests, t, wt, id);
                  if (cfg.references !== "off")
                    for (const nm of names) {
                      if (nm === "default" || nm === "*" || nm === "system") continue;
                      const sym = symIn.get(KIND.symbol, t, nm);
                      if (sym) w.edge(id, EDGE.references, sym.id, 1, id);
                    }
                }
                count++;
                edges++;
              } else if (r.module) {
                w.edge(id, EDGE.imports, moduleNode(r.module), r.w ?? 1, id);
                count++;
              }
            }
          }
          if (!count) unresolved++;
          setRes.run(count, id, s.spec, s.kind);
          n += count;
        }
        // Naming conventions find tests that don't import their subject directly.
        if (isTest && X.testTargets)
          for (const p of X.testTargets(f.key, paths) || []) {
            const t = w.fileIds.get(p);
            if (t && t !== id) w.edge(id, EDGE.tests, t, imported.has(p) ? 1 : 0.8, id);
          }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    await new Promise((r) => setImmediate(r));
  }
  return { files: ids.length, edges, unresolved };
}

export function recomputeDegrees(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`UPDATE node SET deg_in = 0 WHERE deg_in <> 0`);
    db.exec(`UPDATE node SET deg_in = c.n FROM (SELECT dst, count(*) AS n FROM edge WHERE type IN (${EDGE.imports}, ${EDGE.references}) GROUP BY dst) AS c WHERE node.id = c.dst`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

