// Selftest for the knowledge graph (run from lib/selftest.mjs). Builds a small multi-language git repo with a
// known history in a temp dir, indexes it, and checks the build, incremental updates, recall, staleness,
// coupling, locking and the fallback to lexical recall. Skipped when node:sqlite isn't available.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

function makeRepo(dir) {
  let t = Date.parse("2026-06-01T10:00:00Z") / 1000;
  const g = (...a) =>
    execFileSync("git", a, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` },
    });
  const w = (p, s) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  const commit = (msg) => {
    t += 3600;
    g("add", "-A");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg);
  };
  g("init", "-q");
  w(".gitignore", "node_modules/\n");
  w("tsconfig.json", '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } }, }\n');
  w("package.json", '{ "name": "fx", "workspaces": ["packages/*"] }\n');
  w("packages/ui/package.json", '{ "name": "@fx/ui", "main": "src/index.ts" }\n');
  w("packages/ui/src/index.ts", "export function Button() { return 1; }\n");
  w("src/a.ts", 'import { helperB } from "./b.js";\nimport { u } from "@app/util";\nimport { Button } from "@fx/ui";\n\nexport class Widget {\n  size = 1;\n  grow() { return this.size + 1; }\n}\n');
  w("src/b.ts", "export function helperB() {\n  return 1;\n}\n");
  w("src/util.ts", "export const u = 1;\n");
  w("src/a.test.ts", 'import { Widget } from "./a";\ntest("w", () => new Widget());\n');
  w("src/c.ts", "export const ledger = 0;\n");
  w("src/d.ts", "export const rounding = 0;\n");
  w("src/old.ts", "export const legacy = 0;\n");
  w("py/pkg/__init__.py", "");
  w("py/pkg/mod.py", "from .helper import x\n\ndef run():\n    return x\n");
  w("py/pkg/helper.py", "x = 1\n");
  w("go.mod", "module fx\n\ngo 1.22\n");
  w("cmd/main.go", 'package main\n\nimport "fx/internal/lib"\n\nfunc main() { lib.Go() }\n');
  w("internal/lib/lib.go", "package lib\n\nfunc Go() {}\n");
  w("docs/guide.md", "# Guide\n\nSee [the widget](../src/a.ts) and `Widget`.\n");
  w("docs/DECISIONS.md", "| Decision | Where |\n|---|---|\n| Rounding is half-even everywhere | src/d.ts |\n");
  w("img.png", Buffer.from([137, 80, 78, 71, 0, 0, 0, 13, 0, 1, 2]));
  w("src/big.ts", "// big\n" + "export const x = 1;\n".repeat(32000));
  w("excluded/x.ts", "export const ex = 1;\n");
  w("node_modules/x.js", "module.exports = 1;\n");
  commit("initial");
  // c and d change together six times; old.ts goes along twice before it is renamed.
  for (let i = 0; i < 6; i++) {
    w("src/c.ts", `export const ledger = ${i + 1};\n`);
    w("src/d.ts", `export const rounding = ${i + 1};\n`);
    if (i < 2) w("src/old.ts", `export const legacy = ${i + 1};\n`);
    commit(`ledger rounding step ${i}`);
  }
  for (let i = 0; i < 60; i++) w(`fmt/f${i}.ts`, `export const f${i} = ${i};\n`);
  commit("add fmt files");
  for (let i = 0; i < 60; i++) w(`fmt/f${i}.ts`, `export const f${i} = ${i}; // formatted\n`);
  commit("format everything");
  g("mv", "src/old.ts", "src/e.ts");
  commit("rename old to e");
  return { g, w, commit };
}

export async function graphSelftest({ check, env: baseEnv }) {
  const db = await import("./db.mjs");
  if (!db.loadSqlite()) {
    console.log("  skip  graph: node:sqlite unavailable");
    return;
  }
  const saved = { CAIRN_DIR: process.env.CAIRN_DIR, CAIRN_CONFIG: process.env.CAIRN_CONFIG };
  const dir = mkdtempSync(join(tmpdir(), "cairn-graph-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const store = join(dir, "store");
  const cfgFile = join(dir, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ project: { person: "Robin", graph: { exclude: ["excluded/"], cochange: { minIntervalMin: 0 } } } }));
  process.env.CAIRN_DIR = store;
  process.env.CAIRN_CONFIG = cfgFile;
  const env = { ...baseEnv, CAIRN_DIR: store, CAIRN_CONFIG: cfgFile, CAIRN_GRAPH_AUTO: "0" };
  try {
    const R = makeRepo(repo);
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim();
    const { projectConfig } = await import("../config.mjs");
    projectConfig(root, { fresh: true });
    const { runWorker } = await import("./worker.mjs");
    const { KIND, EDGE, ROLE, FLAG } = await import("./schema.mjs");
    const store_ = await import("../store.mjs");
    const ctx = await import("../context.mjs");
    const recall = await import("./recall.mjs");

    // A learning that only the graph can reach (it cites d.ts; prompts will name c.ts), one about util.ts, and
    // one unrelated. Recorded before the build so the first sync picks them up.
    store_.addLearning(root, { text: "Totals must be rounded half-even before saving.", source: "manual", refs: ["src/d.ts"] });
    store_.addLearning(root, { text: "Configuration values are frozen at startup.", source: "manual", refs: ["src/util.ts"] });
    store_.addLearning(root, { text: "Pagination tokens expire after an hour.", source: "manual", refs: ["py/pkg/helper.py"] });
    store_.addLearning(root, { text: "Widgets grow by one on every call.", source: "manual", refs: ["src/a.ts#Widget"] });

    // Fallback: before any graph exists, and with the graph off, recall is the lexical one, byte for byte.
    const strip = (r) => (r ? r.text.replace(/captured="[^"]+"/g, "") : null);
    const PROMPT = "please fix the ledger rounding bug in src/c.ts";
    const lexical = strip(ctx.buildPromptContext(root, PROMPT, {}));

    const s1 = await runWorker(root, { mode: "auto", fg: true, quiet: true });
    db.closeReaders();
    check("graph: a first build finishes and is ready", !s1.error && !s1.pending && s1.extracted > 0, JSON.stringify(s1).slice(0, 300));
    const h = db.openRead(root);
    check("graph: the built graph opens read-only", !!h);
    const file = (p) => h.prepare("SELECT * FROM node WHERE kind=? AND key=?").get(KIND.file, p);
    const edge = (a, t, b) => !!h.prepare("SELECT 1 FROM edge WHERE src=? AND type=? AND dst=?").get(file(a)?.id, t, file(b)?.id);
    check(
      "graph: binary, oversized and excluded files are known but not read; ignored ones are absent",
      file("img.png")?.role === ROLE.binary && file("src/big.ts")?.role === ROLE.too_big && file("excluded/x.ts")?.role === ROLE.excluded && !file("node_modules/x.js"),
    );
    check(
      "graph: imports resolve (TS .js→.ts, tsconfig alias, workspace package, Python relative, Go package)",
      edge("src/a.ts", EDGE.imports, "src/b.ts") &&
        edge("src/a.ts", EDGE.imports, "src/util.ts") &&
        edge("src/a.ts", EDGE.imports, "packages/ui/src/index.ts") &&
        edge("py/pkg/mod.py", EDGE.imports, "py/pkg/helper.py") &&
        edge("cmd/main.go", EDGE.imports, "internal/lib/lib.go"),
    );
    check(
      "graph: tests, docs and symbols are linked",
      edge("src/a.test.ts", EDGE.tests, "src/a.ts") &&
        edge("docs/guide.md", EDGE.documents, "src/a.ts") &&
        !!h.prepare("SELECT 1 FROM node WHERE kind=? AND file_id=? AND name='Widget'").get(KIND.symbol, file("src/a.ts").id),
    );
    const cw = h.prepare("SELECT w FROM edge WHERE src=? AND type=? AND dst=?").get(file("src/c.ts").id, EDGE.co_changed, file("src/d.ts").id)?.w || 0;
    check(
      "graph: co-change pairs files that change together, skips the mass commit, follows the rename",
      cw >= 0.5 && !edge("fmt/f1.ts", EDGE.co_changed, "fmt/f2.ts") && edge("src/e.ts", EDGE.co_changed, "src/d.ts"),
      `c~d ${cw}`,
    );

    const growId = h.prepare("SELECT id FROM node WHERE kind=? AND name LIKE 'Widgets grow%'").get(KIND.learning)?.id;
    const widgetSym = h.prepare("SELECT id FROM node WHERE kind=? AND file_id=? AND name='Widget'").get(KIND.symbol, file("src/a.ts").id)?.id;
    check(
      "graph: a learning recorded before the first build links to the symbol it cites",
      !!growId && !!widgetSym && !!h.prepare("SELECT 1 FROM edge WHERE src=? AND type=? AND dst=?").get(growId, EDGE.cites, widgetSym),
    );

    // Recall through the graph.
    const viaGraph = ctx.buildPromptContext(root, PROMPT, {});
    check(
      "graph: a fact citing a co-changing file is recalled, with how it was reached",
      !!viaGraph && viaGraph.text.includes("half-even") && /via [^)]*changes with/.test(viaGraph.text),
      viaGraph?.text.slice(-400),
    );
    check(
      "graph: recall without the graph is unchanged (it found nothing on words alone)",
      !lexical || !lexical.includes("half-even"),
    );
    const weak = ctx.buildPromptContext(root, "rename a few things in src/b.ts", {});
    check("graph: weak structure alone recalls nothing", !weak || (!weak.text.includes("frozen at startup") && !weak.text.includes("Pagination")), weak?.text.slice(-300));
    const dec = ctx.buildPromptContext(root, "change how src/d.ts rounds totals", {});
    check("graph: a decision about the file in play is shown", !!dec && dec.text.includes("half-even everywhere") && dec.keys.some((k) => k.startsWith("decision:")), dec?.text.slice(-300));
    process.env.CAIRN_GRAPH = "0";
    const off = strip(ctx.buildPromptContext(root, PROMPT, {}));
    delete process.env.CAIRN_GRAPH;
    check("graph: CAIRN_GRAPH=0 gives the lexical recall byte for byte", off === lexical);
    const garbage = join(dir, "garbage.db");
    writeFileSync(garbage, "not a database at all");
    process.env.CAIRN_GRAPH_DB = garbage;
    db.closeReaders();
    const bad = strip(ctx.buildPromptContext(root, PROMPT, {}));
    delete process.env.CAIRN_GRAPH_DB;
    db.closeReaders();
    check("graph: a corrupt database falls back to lexical recall", bad === lexical);

    // Incremental: one changed file is the only one read.
    R.w("src/b.ts", "export function helperB() {\n  return 2;\n}\n");
    R.commit("change b");
    const s2 = await runWorker(root, { mode: "update", quiet: true });
    check("graph: an update re-reads only the changed file", s2.extracted === 1 && s2.changed === 1, JSON.stringify(s2).slice(0, 200));
    renameSync(join(root, "src/util.ts"), join(dir, "util.ts.bak"));
    R.commit("drop util");
    await runWorker(root, { mode: "update", quiet: true });
    db.closeReaders();
    let h2 = db.openRead(root);
    const util = h2.prepare("SELECT * FROM node WHERE kind=1 AND key='src/util.ts'").get();
    const aId = h2.prepare("SELECT id FROM node WHERE kind=1 AND key='src/a.ts'").get().id;
    const res = () => h2.prepare("SELECT resolved FROM spec WHERE file_id=? AND spec='@app/util'").get(aId)?.resolved;
    check("graph: a deleted file is flagged, and imports of it become unresolved", (util.flags & FLAG.deleted) !== 0 && res() === 0);
    renameSync(join(dir, "util.ts.bak"), join(root, "src/util.ts"));
    R.commit("restore util");
    const s3 = await runWorker(root, { mode: "update", quiet: true });
    db.closeReaders();
    h2 = db.openRead(root);
    check("graph: a file that comes back re-resolves its importers without re-reading them", res() === 1 && s3.extracted === 1, JSON.stringify(s3).slice(0, 200));

    // Symbol staleness: a rename with the same body flags the fact; a body change alone doesn't.
    store_.addLearning(root, { text: "Widget sizes start at one so empty layouts still render.", source: "manual", refs: ["src/a.ts#Widget"] });
    store_.addLearning(root, { text: "The helper returns a constant on purpose for the replay tests.", source: "manual", refs: ["src/b.ts#helperB"] });
    R.w("src/a.ts", 'import { helperB } from "./b.js";\nimport { u } from "@app/util";\nimport { Button } from "@fx/ui";\n\nexport class Gadget {\n  size = 1;\n  grow() { return this.size + 1; }\n}\n');
    R.w("src/b.ts", "export function helperB() {\n  return 3;\n}\n");
    R.commit("rename Widget, tweak helper");
    await runWorker(root, { mode: "update", quiet: true });
    db.closeReaders();
    const mirror = recall.mirrorLearnings(root) || [];
    const wid = mirror.find((l) => l.text.startsWith("Widget sizes"));
    const hel = mirror.find((l) => l.text.startsWith("The helper returns"));
    check(
      "graph: a renamed symbol flags the facts citing it; a changed body doesn't",
      wid?.stale && /renamed to `Gadget`/.test(wid.stale_reason || "") && hel && !hel.stale,
      `${wid?.stale_reason} / ${hel?.stale}`,
    );
    check("graph: the learning mirror matches the store", mirror.length === store_.recallable(root).length);

    // Coupling: another live session editing d.ts hears that c.ts usually changes with it, once.
    const now = new Date().toISOString();
    mkdirSync(join(store, "state"), { recursive: true });
    writeFileSync(join(store, "state", "st-graph-b.json"), JSON.stringify({ activity: { files: { "src/d.ts": now }, last_active: now, task: "rounding rules" } }));
    const run = (sid) =>
      spawnSync(process.execPath, [join(HOOKS, "post_tool_use.mjs")], {
        input: JSON.stringify({ session_id: sid, tool_name: "Edit", tool_input: { file_path: join(root, "src/c.ts") }, cwd: root }),
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 15000,
      });
    const first = run("st-graph-a");
    const second = run("st-graph-a");
    check(
      "graph: an edit to a file tied to another session's file warns once (coupling), with no stderr noise",
      first.stdout.includes('kind=\\"coupling\\"') && first.stdout.includes("src/d.ts") && !second.stdout.includes("coupling") && !first.stderr,
      first.stdout.slice(0, 300) + first.stderr,
    );

    // Routing: `who` finds the session working next door.
    const cfgDir = process.env.CLAUDE_CONFIG_DIR;
    mkdirSync(join(cfgDir, "sessions"), { recursive: true });
    writeFileSync(join(cfgDir, "sessions", "9901.json"), JSON.stringify({ sessionId: "st-graph-b", cwd: root, name: "Rounding", status: "idle" }));
    const { whoFor } = await import("../report.mjs");
    const ranked = whoFor(root, "src/c.ts");
    check("graph: `who` ranks a session editing a closely tied file", ranked[0]?.s.sessionId === "st-graph-b", JSON.stringify(ranked.map((r) => [r.s.sessionId, r.score])));
    rmSync(join(cfgDir, "sessions", "9901.json"), { force: true });

    // Inferred areas: the Go code and the TS code land in different areas.
    // Inferred areas: files that change together share one; the 60 formatting files form their own.
    const cArea = recall.inferredAreaOf(root, "src/c.ts")?.name;
    const dArea = recall.inferredAreaOf(root, "src/d.ts")?.name;
    const fArea = recall.inferredAreaOf(root, "fmt/f1.ts")?.name;
    check("graph: inferred areas group related files and separate unrelated ones", !!cArea && cArea === dArea && !!fArea && fArea !== cArea, `${cArea} / ${dArea} / ${fArea}`);

    // Locking: a second writer backs off; a dead writer's lock is taken over.
    const { acquire } = await import("./lock.mjs");
    const release = acquire(root, "test");
    const blocked = await runWorker(root, { mode: "update", quiet: true });
    release();
    const { graphPaths } = db;
    writeFileSync(graphPaths(root).lock, JSON.stringify({ pid: 1, at: 1, beat: Date.now() - 10 * 60000 }));
    const stolen = await runWorker(root, { mode: "update", quiet: true });
    check("graph: one writer at a time; a stale lock is taken over", !!blocked.skipped && !stolen.skipped && !stolen.error, `${JSON.stringify(blocked)} ${JSON.stringify(stolen).slice(0, 120)}`);

    // Compaction keeps symbol baselines.
    const { appendFileSync, readFileSync } = await import("node:fs");
    const lpath = join(store, "learnings.jsonl");
    appendFileSync(lpath, readFileSync(lpath, "utf8").split("\n").filter(Boolean).slice(-1)[0] + "\n"); // a duplicate row
    const { gc } = await import("../lifecycle.mjs");
    gc(root, { compact: true });
    check(
      "graph: gc --compact keeps the symbols a learning cites",
      store_.readLearnings(root).some((r) => r.sym_refs && Object.keys(r.sym_refs).some((k) => k.endsWith("#helperB"))),
    );

    // A plain word that is part of a code name ("helper" -> helperB) is a guess: it seeds routing but recalls no
    // memory through the graph. The typed name does.
    const loose = recall.graphRecall(root, { text: "the helper looks off", terms: ["helper"], files: [] });
    const typed = recall.graphRecall(root, { text: "check `helperB` again", terms: ["check"], files: [] });
    check(
      "graph: word-only name matches recall no memory; a typed identifier does",
      loose && loose.learnings.size === 0 && loose.checkpoints.size === 0 && typed && typed.learnings.size > 0,
      `loose ${loose?.learnings.size}/${loose?.checkpoints.size}, typed ${typed?.learnings.size}`,
    );

    // Speed: graph recall stays well inside a hook's budget.
    db.closeReaders();
    const times = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      recall.graphRecall(root, { text: PROMPT, terms: ["ledger", "rounding"], files: ["src/c.ts"], editedFiles: ["src/a.ts"] });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    check("graph: recall median under 50 ms", times[5] < 50, `${times[5].toFixed(1)} ms`);
  } finally {
    db.closeReaders();
    process.env.CAIRN_DIR = saved.CAIRN_DIR;
    process.env.CAIRN_CONFIG = saved.CAIRN_CONFIG;
    const { projectConfig } = await import("../config.mjs");
    projectConfig(process.cwd(), { fresh: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
