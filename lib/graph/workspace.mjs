// Workspace discovery for the resolver: the config files that change how imports
// map to files (tsconfig paths, package.json names and entries, go.mod, Cargo.toml,
// composer.json psr-4). Only files already in the indexed file list are read — no
// directory walking — and each read is guarded, so a broken config just counts as absent.

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

export const JS_EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];
const JS_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"];
const ESM_REMAP = { ".js": [".ts", ".tsx", ".d.ts"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

export function dirOf(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

export function baseOf(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}

// Repo-relative normalize; null when the path climbs out of the repo.
export function norm(p) {
  const n = posix.normalize(p);
  if (n === "." || n === "./") return "";
  if (n === ".." || n.startsWith("../") || n.startsWith("/")) return null;
  return n.replace(/^\.\//, "").replace(/\/$/, "");
}

export function joinRel(dir, spec) {
  return norm(dir ? `${dir}/${spec}` : spec);
}

// Set, basename → paths and dir → paths, built once per file list.
const indexCache = new WeakMap();
export function fileIndex(files) {
  if (files && typeof files === "object" && indexCache.has(files)) return indexCache.get(files);
  const set = new Set();
  const byBase = new Map();
  const byDir = new Map();
  for (const f of files || []) {
    if (typeof f !== "string" || set.has(f)) continue;
    set.add(f);
    const b = baseOf(f);
    const d = dirOf(f);
    (byBase.get(b) || byBase.set(b, []).get(b)).push(f);
    (byDir.get(d) || byDir.set(d, []).get(d)).push(f);
  }
  const idx = { set, byBase, byDir };
  if (files && typeof files === "object") indexCache.set(files, idx);
  return idx;
}

// JS-style probing: exact, TS-ESM remap (./b.js → b.ts), extensions, index files.
export function probeJs(set, base) {
  if (base === null || base === undefined) return null;
  if (base && set.has(base)) return base;
  const ext = base.match(/\.[mc]?jsx?$/);
  if (ext) {
    const stem = base.slice(0, -ext[0].length);
    for (const e of ESM_REMAP[ext[0]] || []) if (set.has(stem + e)) return stem + e;
  }
  for (const e of JS_EXTS) if (set.has(base + e)) return base + e;
  for (const e of JS_INDEX) {
    const p = base ? base + e : e.slice(1);
    if (set.has(p)) return p;
  }
  return null;
}

function readText(root, rel) {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

export function parseJsonc(text) {
  if (typeof text !== "string") return null;
  try {
    const noComments = text
      .replace(/^﻿/, "")
      .replace(/("(?:[^"\\\n]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s || "");
    return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

function readJson(root, rel) {
  return parseJsonc(readText(root, rel));
}

const skipped = (p) => /(^|\/)node_modules\//.test(p);

// package.json `exports` condition picking: source-ish conditions first, since
// built output (dist/) usually isn't indexed.
const CONDITIONS = ["source", "import", "module", "default", "require", "node", "types"];
function pickExport(v, depth = 0) {
  if (depth > 5 || v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = pickExport(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof v === "object") {
    for (const k of CONDITIONS) if (k in v) {
      const r = pickExport(v[k], depth + 1);
      if (r) return r;
    }
    for (const k of Object.keys(v)) {
      const r = pickExport(v[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// A package-relative target → an indexed file, also trying dist/ → src/.
function probePkgTarget(set, dir, target) {
  if (!target) return null;
  const p = joinRel(dir, target);
  const hit = probeJs(set, p);
  if (hit || p === null) return hit;
  const rel = norm(target);
  const m = rel && rel.match(/^(?:dist|build|lib|out|esm|cjs)\/(.*?)(?:\.d)?\.[mc]?[jt]sx?$/);
  return m ? probeJs(set, joinRel(dir, `src/${m[1]}`)) : null;
}

function packageEntry(set, dir, json) {
  const ex = json.exports;
  let root = null;
  if (typeof ex === "string" || Array.isArray(ex)) root = ex;
  else if (ex && typeof ex === "object") root = "." in ex ? ex["."] : Object.keys(ex).some((k) => k.startsWith(".")) ? null : ex;
  const targets = [pickExport(root), json.module, json.main, json.types, json.typings, "src/index", "index"];
  for (const t of targets) {
    const hit = typeof t === "string" ? probePkgTarget(set, dir, t) : null;
    if (hit) return hit;
  }
  return null;
}

// `@scope/ui/button` inside package `@scope/ui`: exports map first, then plain paths.
export function packageSubpath(set, pkg, sub) {
  const ex = pkg.exports;
  if (ex && typeof ex === "object" && !Array.isArray(ex)) {
    const key = `./${sub}`;
    if (key in ex) {
      const hit = probePkgTarget(set, pkg.dir, pickExport(ex[key]));
      if (hit) return hit;
    }
    for (const k of Object.keys(ex)) {
      const star = k.indexOf("*");
      if (star === -1) continue;
      const pre = k.slice(0, star);
      const post = k.slice(star + 1);
      if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
        const mid = key.slice(pre.length, key.length - post.length);
        const t = pickExport(ex[k]);
        const hit = t && probePkgTarget(set, pkg.dir, t.replace("*", mid));
        if (hit) return hit;
      }
    }
  }
  return probeJs(set, joinRel(pkg.dir, sub)) || probeJs(set, joinRel(pkg.dir, `src/${sub}`));
}

// tsconfig/jsconfig, following relative (and workspace-package) `extends`.
function loadTsconfigs(root, idx, pkgByName) {
  const cache = new Map();
  const resolveExtends = (ext, dir) => {
    if (typeof ext !== "string") return null;
    const cands = [];
    if (ext.startsWith(".")) {
      const p = joinRel(dir, ext);
      if (p !== null) cands.push(p, `${p}.json`, `${p}/tsconfig.json`);
    } else {
      for (const [name, pkg] of pkgByName) {
        if (ext === name) cands.push(joinRel(pkg.dir, "tsconfig.json"));
        else if (ext.startsWith(`${name}/`)) {
          const p = joinRel(pkg.dir, ext.slice(name.length + 1));
          cands.push(p, `${p}.json`);
        }
      }
    }
    return cands.find((c) => c !== null && idx.set.has(c)) || null;
  };
  const load = (rel, depth = 0) => {
    if (cache.has(rel)) return cache.get(rel);
    cache.set(rel, {}); // cycle guard
    const json = depth < 10 ? readJson(root, rel) : null;
    let cfg = {};
    if (json && typeof json === "object") {
      const dir = dirOf(rel);
      const exts = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
      for (const e of exts) {
        const target = resolveExtends(e, dir);
        if (target) cfg = { ...cfg, ...load(target, depth + 1) };
      }
      const co = json.compilerOptions || {};
      if (typeof co.baseUrl === "string") cfg.baseUrl = joinRel(dir, co.baseUrl);
      if (co.paths && typeof co.paths === "object") {
        cfg.paths = co.paths;
        cfg.pathsDir = dir;
      }
    }
    cache.set(rel, cfg);
    return cfg;
  };
  const byDir = new Map();
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    for (const rel of idx.byBase.get(name) || []) {
      if (skipped(rel) || byDir.has(dirOf(rel))) continue;
      const cfg = load(rel);
      byDir.set(dirOf(rel), compilePaths(cfg));
    }
  }
  return byDir;
}

// { "@app/*": ["src/*"] } → patterns, most specific (longest prefix) first.
export function compilePaths(cfg) {
  const base = cfg.baseUrl ?? cfg.pathsDir ?? null;
  const patterns = [];
  for (const [key, targets] of Object.entries(cfg.paths || {})) {
    if (!Array.isArray(targets)) continue;
    const star = key.indexOf("*");
    patterns.push({
      prefix: star === -1 ? key : key.slice(0, star),
      suffix: star === -1 ? "" : key.slice(star + 1),
      star: star !== -1,
      targets: targets.filter((t) => typeof t === "string"),
    });
  }
  patterns.sort((a, b) => b.prefix.length - a.prefix.length);
  return { baseUrl: cfg.baseUrl ?? null, base: base ?? "", patterns };
}

function tomlSection(text, name) {
  const m = text.match(new RegExp(`^\\[${name.replace(/[.]/g, "\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"));
  return m ? m[1] : null;
}

export function discover(root, idx, opts = {}) {
  const { set, byBase, byDir } = idx;

  const pkgByName = new Map();
  for (const rel of byBase.get("package.json") || []) {
    if (skipped(rel)) continue;
    const json = readJson(root, rel);
    if (!json || typeof json.name !== "string" || !json.name) continue;
    const dir = dirOf(rel);
    pkgByName.set(json.name, { name: json.name, dir, exports: json.exports, entry: packageEntry(set, dir, json) });
  }
  // Longest names first so `@a/b-c` wins over `@a/b` on prefix checks.
  const packages = [...pkgByName.values()].sort((a, b) => b.name.length - a.name.length);

  const tsconfigs = loadTsconfigs(root, idx, pkgByName);

  const goModules = [];
  for (const rel of byBase.get("go.mod") || []) {
    const m = (readText(root, rel) || "").match(/^module\s+"?([^\s"]+)"?/m);
    if (m) goModules.push({ path: m[1], dir: dirOf(rel) });
  }
  goModules.sort((a, b) => b.path.length - a.path.length);

  const crates = [];
  for (const rel of byBase.get("Cargo.toml") || []) {
    const text = readText(root, rel) || "";
    const pkg = tomlSection(text, "package");
    const name = pkg && (pkg.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1];
    if (!name) continue;
    const dir = dirOf(rel);
    const lib = tomlSection(text, "lib");
    const libPath = lib && (lib.match(/^\s*path\s*=\s*"([^"]+)"/m) || [])[1];
    const cands = [libPath && joinRel(dir, libPath), joinRel(dir, "src/lib.rs"), joinRel(dir, "src/main.rs")];
    crates.push({ name, ident: name.replace(/-/g, "_"), dir, src: joinRel(dir, "src"), root: cands.find((c) => c && set.has(c)) || null });
  }

  const psr4 = [];
  for (const rel of byBase.get("composer.json") || []) {
    if (/(^|\/)vendor\//.test(rel)) continue;
    const json = readJson(root, rel);
    if (!json) continue;
    for (const section of [json.autoload, json["autoload-dev"]]) {
      for (const [prefix, dirs] of Object.entries((section && section["psr-4"]) || {})) {
        const list = (Array.isArray(dirs) ? dirs : [dirs]).filter((d) => typeof d === "string");
        psr4.push({ prefix: prefix.replace(/^\\/, ""), dirs: list.map((d) => joinRel(dirOf(rel), d)).filter((d) => d !== null) });
      }
    }
  }
  psr4.sort((a, b) => b.prefix.length - a.prefix.length);

  // Python import roots: the repo, src/, configured ones, and the parent of the
  // top of every __init__.py chain (so `foo/pkg/__init__.py` makes foo/ a root).
  const pyRoots = ["", "src", ...(opts.pythonRoots || []).map((r) => norm(r)).filter((r) => r !== null)];
  for (const init of byBase.get("__init__.py") || []) {
    let d = dirOf(init);
    while (d && set.has(`${dirOf(d) ? `${dirOf(d)}/` : ""}__init__.py`)) d = dirOf(d);
    const r = dirOf(d);
    if (d && !pyRoots.includes(r)) pyRoots.push(r);
  }

  // C include roots: every `include/` dir, plus configured ones.
  const includeDirs = [];
  for (const d of byDir.keys()) {
    const m = d.match(/^(.*?(?:^|\/)include)(?:\/|$)/);
    if (m && !includeDirs.includes(m[1])) includeDirs.push(m[1]);
  }
  for (const d of opts.includeDirs || []) {
    const n = norm(d);
    if (n !== null && !includeDirs.includes(n)) includeDirs.push(n);
  }

  return { packages, pkgByName, tsconfigs, goModules, crates, psr4, pyRoots, includeDirs };
}
