// Import → file resolution for the knowledge graph. buildResolver reads the
// workspace configs once (workspace.mjs); after that every resolve() is a handful
// of Set/Map probes, so 100k files and 100k imports stay cheap.
//
// A result is { path, w } for an indexed file (w < 1 when one import fans out to
// a whole package dir or namespace) or { module, w } for an external dependency
// ("ext:npm:react"). Unresolvable internal-looking imports give [].

import { builtinModules } from "node:module";
import { baseOf, dirOf, discover, fileIndex, joinRel, norm, packageSubpath, probeJs } from "./workspace.mjs";

const FANOUT_CAP = 20;
const NODE_BUILTINS = new Set(builtinModules);

function spread(paths) {
  const list = paths.slice(0, FANOUT_CAP);
  return list.map((path) => ({ path, w: 1 / list.length }));
}

function one(path) {
  return path ? [{ path, w: 1 }] : [];
}

function ext(module) {
  return [{ module, w: 1 }];
}

function uniq(paths) {
  return [...new Set(paths.filter(Boolean))].map((path) => ({ path, w: 1 }));
}

export function buildResolver(root, files, opts = {}) {
  const idx = fileIndex(files);
  const { set, byBase, byDir } = idx;
  let ws;
  try {
    ws = discover(root, idx, opts);
  } catch {
    ws = { packages: [], pkgByName: new Map(), tsconfigs: new Map(), goModules: [], crates: [], psr4: [], pyRoots: [""], includeDirs: [] };
  }

  // opts.pathAliases act as a repo-root tsconfig `paths` fallback.
  const aliasCfg = opts.pathAliases ? compileAliases(opts.pathAliases) : null;

  // Package declarations the caller extracted: jvm/csharp/php FQN maps.
  const pkgFiles = { jvm: new Map(), csharp: new Map(), php: new Map() };
  const classIndex = { jvm: new Map(), csharp: new Map(), php: new Map() };
  for (const p of opts.packages || []) {
    if (!p || typeof p.path !== "string" || typeof p.pkg !== "string" || !set.has(p.path)) continue;
    const lang = p.lang || langFromPath(p.path);
    if (!pkgFiles[lang]) continue;
    const sep = lang === "php" ? "\\" : ".";
    const pkg = p.pkg.replace(/^\\/, "");
    (pkgFiles[lang].get(pkg) || pkgFiles[lang].set(pkg, []).get(pkg)).push(p.path);
    const names = new Set([baseOf(p.path).replace(/\.[^.]+$/, ""), ...(Array.isArray(p.symbols) ? p.symbols : [])]);
    for (const n of names) {
      const key = pkg ? `${pkg}${sep}${n}` : n;
      if (!classIndex[lang].has(key)) classIndex[lang].set(key, p.path);
    }
  }

  // Nearest tsconfig/jsconfig up the tree, cached per dir.
  const tsNear = new Map();
  const nearestTs = (dir) => {
    if (tsNear.has(dir)) return tsNear.get(dir);
    const cfg = ws.tsconfigs.get(dir) || (dir ? nearestTs(dirOf(dir)) : null);
    tsNear.set(dir, cfg);
    return cfg;
  };

  // An alias that matches but finds no file is still internal: it must not turn into an "external package".
  const aliasMatches = (cfg, spec) =>
    !!cfg && cfg.patterns.some((p) => (p.star ? spec.startsWith(p.prefix) && spec.endsWith(p.suffix) : spec === p.prefix));

  function viaPaths(cfg, spec) {
    for (const p of cfg.patterns) {
      let mid;
      if (p.star) {
        if (!spec.startsWith(p.prefix) || !spec.endsWith(p.suffix) || spec.length < p.prefix.length + p.suffix.length) continue;
        mid = spec.slice(p.prefix.length, spec.length - p.suffix.length);
      } else if (spec !== p.prefix) continue;
      for (const t of p.targets) {
        const hit = probeJs(set, joinRel(cfg.base, p.star ? t.replace("*", mid) : t));
        if (hit) return hit;
      }
    }
    return null;
  }

  function resolveJs(from, spec) {
    if (spec.startsWith(".")) return one(probeJs(set, joinRel(dirOf(from), spec)));
    if (spec.startsWith("/")) return one(probeJs(set, norm(spec.slice(1))));
    const cfg = nearestTs(dirOf(from));
    if (cfg) {
      const hit = viaPaths(cfg, spec) || (cfg.baseUrl !== null ? probeJs(set, joinRel(cfg.baseUrl, spec)) : null);
      if (hit) return one(hit);
    }
    if (aliasCfg) {
      const hit = viaPaths(aliasCfg, spec);
      if (hit) return one(hit);
    }
    if (aliasMatches(cfg, spec) || aliasMatches(aliasCfg, spec)) return [];
    for (const pkg of ws.packages) {
      if (spec === pkg.name) return pkg.entry ? one(pkg.entry) : [];
      if (spec.startsWith(`${pkg.name}/`)) return one(packageSubpath(set, pkg, spec.slice(pkg.name.length + 1)));
    }
    if (spec.startsWith("node:")) return ext(`ext:node:${spec.slice(5).split("/")[0]}`);
    const parts = spec.split("/");
    if (NODE_BUILTINS.has(parts[0])) return ext(`ext:node:${parts[0]}`);
    const name = spec.startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
    if (!/^[@\w.-][\w./@-]*$/.test(name)) return [];
    return ext(`ext:npm:${name}`);
  }

  // Python: a module path → its .py / package __init__.py.
  const pyMod = (p) => {
    if (p === null) return null;
    for (const c of p ? [`${p}.py`, `${p}.pyi`, `${p}/__init__.py`] : ["__init__.py"]) if (set.has(c)) return c;
    return null;
  };
  function pySubs(mod, names) {
    return names.filter((n) => n !== "*").map((n) => pyMod(joinRel(mod, n)));
  }
  function resolvePython(from, imp) {
    const spec = imp.spec;
    const names = imp.names || [];
    if (spec.startsWith(".")) {
      const dots = spec.match(/^\.+/)[0].length;
      let base = dirOf(from);
      for (let i = 1; i < dots; i++) {
        if (!base) return [];
        base = dirOf(base);
      }
      const rest = spec.slice(dots).replace(/\./g, "/");
      const mod = rest ? joinRel(base, rest) : base;
      return uniq([pyMod(mod), ...pySubs(mod, names)]);
    }
    const rel = spec.replace(/\./g, "/");
    for (const r of ws.pyRoots) {
      const mod = joinRel(r, rel);
      const hits = [pyMod(mod), ...pySubs(mod, names)].filter(Boolean);
      if (hits.length) return uniq(hits);
    }
    return ext(`ext:py:${spec.split(".")[0]}`);
  }

  function resolveGo(spec) {
    for (const m of ws.goModules) {
      if (spec !== m.path && !spec.startsWith(`${m.path}/`)) continue;
      const dir = joinRel(m.dir, spec.slice(m.path.length + 1));
      const goFiles = (byDir.get(dir) || []).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")).sort();
      return goFiles.map((path) => ({ path, w: 1 / goFiles.length }));
    }
    return ext(`ext:go:${spec}`);
  }

  // Rust: walk module segments from a module file, child by child.
  const crateNear = new Map();
  const nearestCrate = (dir) => {
    if (crateNear.has(dir)) return crateNear.get(dir);
    const c = ws.crates.find((k) => k.dir === dir) || (dir ? nearestCrate(dirOf(dir)) : null);
    crateNear.set(dir, c);
    return c;
  };
  const childOf = (file, name) => {
    const b = baseOf(file);
    const dir = b === "lib.rs" || b === "main.rs" || b === "mod.rs" ? dirOf(file) : file.slice(0, -3);
    for (const c of [joinRel(dir, `${name}.rs`), joinRel(dir, `${name}/mod.rs`)]) if (c && set.has(c)) return c;
    return null;
  };
  // Longest prefix of `segs` that exists below `start`; `start` itself if none.
  const walk = (start, segs) => {
    let file = start;
    for (const s of segs) {
      const next = childOf(file, s);
      if (!next) break;
      file = next;
    }
    return file;
  };
  // The crate root and module path for an importing file.
  function rustContext(from) {
    const crate = nearestCrate(dirOf(from));
    if (!crate) return { crate: null, rootFile: from, segs: [] };
    const src = crate.src;
    if (!from.startsWith(`${src}/`)) return { crate, rootFile: from, segs: [] };
    const rel = from.slice(src.length + 1);
    if (rel === "main.rs" || rel === "lib.rs" || rel.startsWith("bin/")) return { crate, rootFile: from, segs: [] };
    const segs = rel.slice(0, -3).split("/");
    if (segs[segs.length - 1] === "mod") segs.pop();
    return { crate, rootFile: crate.root || from, segs };
  }
  function resolveRust(from, imp) {
    const ctx = rustContext(from);
    if (imp.kind === "mod") return one(childOf(from, imp.spec));
    const segs = imp.spec.split("::").filter(Boolean);
    const names = (imp.names || []).filter((n) => n !== "*" && n !== "self");
    // `use a::b::c` already names c in the spec; braces/globs add leaves.
    const leaves = names.length === 1 && names[0] === segs[segs.length - 1] ? [] : names;
    const fromBase = (start, rest) => {
      if (!start || !set.has(start)) return [];
      const out = [walk(start, rest)];
      for (const n of leaves) out.push(walk(start, [...rest, n]));
      return uniq(out);
    };
    const head = segs[0];
    if (head === "crate") return fromBase(walk(ctx.rootFile, []), segs.slice(1));
    if (head === "self" || head === "super") {
      let base = ctx.segs;
      let i = 0;
      for (; segs[i] === "super" || segs[i] === "self"; i++) if (segs[i] === "super") base = base.slice(0, -1);
      const start = base.length ? walkExact(ctx.rootFile, base) : ctx.rootFile;
      return fromBase(start, segs.slice(i));
    }
    // 2018 uniform paths: a child module of the current module wins.
    const here = ctx.segs.length ? walkExact(ctx.rootFile, ctx.segs) : ctx.rootFile;
    if (here && head && childOf(here, head)) return fromBase(here, segs);
    const crate = ws.crates.find((c) => c.ident === head || c.name === head);
    if (crate && crate.root) return fromBase(crate.root, segs.slice(1));
    return head ? ext(`ext:cargo:${head}`) : [];
  }
  function walkExact(start, segs) {
    let file = start;
    for (const s of segs) {
      file = childOf(file, s);
      if (!file) return null;
    }
    return file;
  }

  // JVM: FQN → defining file; a.b.* → the package.
  function suffixMatch(parts, exts) {
    for (let k = parts.length - 1; k >= 1; k--) {
      const rel = parts.slice(0, k + 1).join("/");
      for (const e of exts) {
        const hits = (byBase.get(parts[k] + e) || []).filter((f) => f === rel + e || f.endsWith(`/${rel}${e}`));
        if (hits.length) return hits[0];
      }
    }
    return null;
  }
  function jvmFqn(fqn) {
    const parts = fqn.split(".");
    for (let k = parts.length - 1; k >= 1; k--) {
      const hit = classIndex.jvm.get(`${parts.slice(0, k).join(".")}.${parts[k]}`);
      if (hit) return [hit];
    }
    const hit = suffixMatch(parts, [".java", ".kt", ".scala"]);
    if (hit) return [hit];
    // Kotlin top-level function import: the package's files.
    const pkg = parts.slice(0, -1).join(".");
    if (/^[a-z]/.test(parts[parts.length - 1]) && pkgFiles.jvm.has(pkg)) return pkgFiles.jvm.get(pkg);
    return null;
  }
  function resolveJvm(imp) {
    const spec = imp.spec;
    if (spec.endsWith(".*") || (imp.names || [])[0] === "*") {
      const pkg = spec.replace(/\.\*$/, "");
      const list = pkgFiles.jvm.get(pkg);
      if (list) return spread(list);
      return ext(`ext:jvm:${pkg}`);
    }
    const parts = spec.split(".");
    const names = imp.names || [];
    const fqns = names.length && !(names.length === 1 && names[0] === parts[parts.length - 1]) ? names.map((n) => `${spec}.${n}`) : [spec];
    const out = [];
    for (const f of fqns) {
      const hit = jvmFqn(f);
      if (hit && hit.length === 1) out.push({ path: hit[0], w: 1 });
      else if (hit) out.push(...spread(hit));
    }
    if (out.length) return out;
    const firstClass = parts.findIndex((p) => /^[A-Z]/.test(p));
    const pkg = (firstClass > 0 ? parts.slice(0, firstClass) : parts.length > 1 ? parts.slice(0, -1) : parts).join(".");
    return ext(`ext:jvm:${pkg}`);
  }

  function resolveCsharp(imp) {
    const spec = imp.spec;
    const list = pkgFiles.csharp.get(spec);
    if (list && !imp.static) return spread(list);
    const parts = spec.split(".");
    const ns = parts.slice(0, -1).join(".");
    const cls = classIndex.csharp.get(spec) || (pkgFiles.csharp.get(ns) || []).find((f) => baseOf(f) === `${parts[parts.length - 1]}.cs`);
    if (cls) return one(cls);
    if (list) return spread(list);
    return ext(`ext:nuget:${parts[0]}`);
  }

  function resolveC(from, imp) {
    const spec = imp.spec;
    const system = (imp.names || []).includes("system");
    const dirs = [...(system ? [] : [dirOf(from)]), "", ...ws.includeDirs];
    for (const d of dirs) {
      const p = joinRel(d, spec);
      if (p && set.has(p)) return one(p);
    }
    const cands = (byBase.get(baseOf(spec)) || []).filter((f) => f === spec || f.endsWith(`/${spec}`));
    return cands.length === 1 ? one(cands[0]) : [];
  }

  function resolveRuby(from, imp) {
    const spec = imp.spec;
    const withExt = spec.endsWith(".rb") ? spec : `${spec}.rb`;
    if (imp.relative || spec.startsWith(".")) return one([joinRel(dirOf(from), withExt)].find((p) => p && set.has(p)));
    for (const p of [`lib/${withExt}`, withExt, joinRel(dirOf(from), withExt)]) if (p && set.has(p)) return one(p);
    const cands = (byBase.get(baseOf(withExt)) || []).filter((f) => f.endsWith(`lib/${withExt}`));
    if (cands.length === 1) return one(cands[0]);
    return imp.load ? [] : ext(`ext:gem:${spec.split("/")[0]}`);
  }

  function phpClass(fqcn) {
    for (const { prefix, dirs } of ws.psr4) {
      if (!fqcn.startsWith(prefix)) continue;
      const rest = fqcn.slice(prefix.length).replace(/\\/g, "/");
      for (const d of dirs) {
        const p = joinRel(d, `${rest}.php`);
        if (p && set.has(p)) return p;
      }
    }
    return classIndex.php.get(fqcn) || null;
  }
  function resolvePhp(from, imp) {
    if (imp.kind === "require") {
      for (const d of [dirOf(from), ""]) {
        const p = joinRel(d, imp.spec);
        if (p && set.has(p)) return one(p);
      }
      return [];
    }
    const spec = imp.spec.replace(/^\\/, "");
    const names = imp.names || [];
    const last = spec.split("\\").pop();
    const fq = names.length && !(names.length === 1 && names[0] === last) ? names.map((n) => `${spec}\\${n}`) : [spec];
    return uniq(fq.map(phpClass));
  }

  function resolveLink(from, spec) {
    let s = spec.split("#")[0].split("?")[0];
    try {
      s = decodeURIComponent(s);
    } catch {}
    if (!s) return [];
    const p = s.startsWith("/") ? norm(s.slice(1)) : joinRel(dirOf(from), s);
    if (p === null) return [];
    for (const c of [p, `${p}/README.md`, `${p}/index.md`]) if (c && set.has(c)) return one(c);
    return [];
  }

  function resolve(fromPath, imp, lang) {
    try {
      if (!imp || typeof imp.spec !== "string" || !imp.spec || imp.kind === "package") return [];
      lang = lang || langFromPath(fromPath);
      if (imp.kind === "link") return resolveLink(fromPath, imp.spec);
      switch (lang) {
        case "js":
          return resolveJs(fromPath, imp.spec);
        case "python":
          return resolvePython(fromPath, imp);
        case "go":
          return resolveGo(imp.spec);
        case "rust":
          return resolveRust(fromPath, imp);
        case "jvm":
          return resolveJvm(imp);
        case "csharp":
          return resolveCsharp(imp);
        case "cfamily":
          return resolveC(fromPath, imp);
        case "ruby":
          return resolveRuby(fromPath, imp);
        case "php":
          return resolvePhp(fromPath, imp);
        case "markdown":
          return resolveLink(fromPath, imp.spec);
        default:
          return [];
      }
    } catch {
      return [];
    }
  }

  const stats = {
    tsconfigs: ws.tsconfigs.size,
    packages: ws.packages.length,
    goModules: ws.goModules.length,
    crates: ws.crates.length,
  };
  return { resolve, stats };
}

function compileAliases(aliases) {
  const patterns = [];
  for (const [key, targets] of Object.entries(aliases)) {
    const list = (Array.isArray(targets) ? targets : [targets]).filter((t) => typeof t === "string");
    const star = key.indexOf("*");
    patterns.push({ prefix: star === -1 ? key : key.slice(0, star), suffix: star === -1 ? "" : key.slice(star + 1), star: star !== -1, targets: list });
  }
  patterns.sort((a, b) => b.prefix.length - a.prefix.length);
  return { baseUrl: null, base: "", patterns };
}

const LANG_BY_EXT = {
  js: "js jsx ts tsx mjs cjs mts cts vue svelte",
  python: "py pyi",
  go: "go",
  rust: "rs",
  jvm: "java kt kts scala",
  csharp: "cs",
  cfamily: "c h cc cpp cxx hpp hh hxx m mm",
  ruby: "rb",
  php: "php",
  markdown: "md mdx rst adoc",
};
const EXT_LANG = new Map();
for (const [lang, exts] of Object.entries(LANG_BY_EXT)) for (const e of exts.split(" ")) EXT_LANG.set(e, lang);
function langFromPath(p) {
  const m = String(p).match(/\.([^./]+)$/);
  return (m && EXT_LANG.get(m[1].toLowerCase())) || null;
}

// --- tests ↔ source -------------------------------------------------------

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec"]);
const RE_TEST_NAME =
  /(\.(test|spec)\.[^./]+$)|(^test_[^/]*\.py$)|(_test\.(py|go|rb|exs?)$)|(_spec\.rb$)|((Test|Tests|Spec|IT)\.(java|kt|kts|scala|groovy|cs|php|swift)$)/;

export function isTestPath(path) {
  const p = String(path || "");
  if (RE_TEST_NAME.test(baseOf(p))) return true;
  return p.split("/").slice(0, -1).some((s) => TEST_DIRS.has(s));
}

const JS_SRC = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];

// Mirror a test dir onto source dirs: tests/a/b → src/a/b, lib/a/b, a/b.
function mirrors(dir, to = ["src", "lib", ""]) {
  const segs = dir ? dir.split("/") : [];
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    if (!TEST_DIRS.has(segs[i])) continue;
    for (const t of to) out.push([...segs.slice(0, i), ...(t ? [t] : []), ...segs.slice(i + 1)].join("/"));
  }
  return out;
}

export function testTargets(testPath, files) {
  try {
    const { set, byBase } = fileIndex(files);
    const dir = dirOf(testPath);
    const base = baseOf(testPath);
    const found = [];
    const tryIn = (dirs, stem, exts) => {
      for (const d of dirs) for (const e of exts) {
        const p = d === null ? null : joinRel(d, stem + e);
        if (p && set.has(p) && p !== testPath) found.push(p);
      }
    };
    const unique = (name, filter = () => true) => {
      const c = (byBase.get(name) || []).filter((f) => f !== testPath && !isTestPath(f) && filter(f));
      if (c.length === 1) found.push(c[0]);
    };
    let m;
    if ((m = base.match(/^(.+)\.(test|spec)\.([mc]?[jt]sx?|vue|svelte)$/))) {
      const dirs = [dir, ...mirrors(dir)];
      if (baseOf(dir) === "__tests__") dirs.splice(1, 0, dirOf(dir));
      tryIn(dirs, m[1], JS_SRC);
      if (!found.length) for (const e of JS_SRC) unique(m[1] + e);
    } else if ((m = base.match(/^test_(.+)\.py$/) || base.match(/^(.+)_test\.py$/))) {
      tryIn([dir, ...mirrors(dir)], m[1], [".py"]);
      if (!found.length) unique(`${m[1]}.py`);
    } else if ((m = base.match(/^(.+)_test\.go$/))) {
      tryIn([dir], m[1], [".go"]);
    } else if ((m = base.match(/^(\w+?)(Tests?|Spec|IT)\.(java|kt|kts|scala|groovy)$/))) {
      // Maven/Gradle layout: src/test/<lang>/a/b → src/main/<lang or another jvm lang>/a/b.
      const mains = [];
      const mm = dir.match(/^(.*?)src\/test\/(\w+)(\/.*)?$/);
      if (mm) for (const l of new Set([mm[2], "java", "kotlin", "scala"])) mains.push(`${mm[1]}src/main/${l}${mm[3] || ""}`);
      tryIn([dir, ...mains, ...mirrors(dir)], m[1], [".java", ".kt", ".scala"]);
      if (!found.length) for (const e of [".java", ".kt", ".scala"]) unique(m[1] + e);
    } else if ((m = base.match(/^(\w+?)Tests?\.cs$/))) {
      unique(`${m[1]}.cs`);
    } else if ((m = base.match(/^(.+)_(spec|test)\.rb$/))) {
      tryIn([dir, ...mirrors(dir, ["lib", "app", ""])], m[1], [".rb"]);
      if (!found.length) unique(`${m[1]}.rb`, (f) => f.startsWith("lib/") || f.startsWith("app/") || f.includes("/lib/") || f.includes("/app/"));
    } else if ((m = base.match(/^(.+)\.test\.php$/) || base.match(/^(\w+?)Test\.php$/))) {
      tryIn([dir, ...mirrors(dir, ["src", "lib", "app"])], m[1], [".php"]);
      if (!found.length) unique(`${m[1]}.php`);
    }
    return [...new Set(found)];
  } catch {
    return [];
  }
}
