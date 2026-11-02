// Cairn's own memory as graph nodes: learnings, checkpoints, threads, jobs, decisions, areas and sessions, linked
// to the files and symbols they cite or touched. Each source is re-synced only when its file changed (size and
// mtime). The learnings are stored already folded, so hooks read them from here instead of re-folding the JSONL on
// every prompt (the "mirror"; lib/graph/recall.mjs).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readAreas } from "../areas.mjs";
import { checkpointKey, foldLearnings } from "../rank.mjs";
import { dataDir, readAllStates, readCheckpoints, readLearnings, readRows, repoKey } from "../store.mjs";
import { meta, metaJson, setMeta, tx } from "./db.mjs";
import { EDGE, FLAG, KIND } from "./schema.mjs";

const sha = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const epoch = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

export function fileSig(path) {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } catch {
    return { size: -1, mtimeMs: 0 };
  }
}
const sameSig = (a, b) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;

// Path-looking tokens in prose: "src/a.ts", "a.ts", "docs/design/x.md".
const PATHISH = /(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z]{1,6}\b/g;
const IDENT = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)(?:\(\))?`/g;

// A mentioned path to a file id: exact, else the one file whose path ends with it.
export function resolveMention(w, raw) {
  const p = String(raw).replace(/\\/g, "/").replace(/^\.\//, "").replace(/[),.;:]+$/, "");
  if (!p || p.length < 3) return null;
  if (w.fileIds.has(p)) return w.fileIds.get(p);
  const base = p.split("/").pop().toLowerCase();
  const hits = w.st.byName.all(KIND.file, base).filter((r) => r.key === p || r.key.endsWith("/" + p));
  return hits.length === 1 ? hits[0].id : null;
}
function mentionEdges(w, src, text, type = EDGE.mentions, wt = 0.8) {
  const seen = new Set();
  for (const m of String(text || "").match(PATHISH) || []) {
    const id = resolveMention(w, m);
    if (id && !seen.has(id)) {
      seen.add(id);
      w.edge(src, type, id, wt);
    }
  }
  for (const m of String(text || "").matchAll(IDENT)) {
    const name = m[1].split(".").pop().toLowerCase();
    const hits = w.st.byName.all(KIND.symbol, name);
    if (hits.length === 1 && !seen.has(hits[0].id)) {
      seen.add(hits[0].id);
      w.edge(src, type, hits[0].id, wt);
    }
  }
}

// Replace every node of `kind` with `items` ([{ key, fields, fts, edges(id) }]); unchanged keys keep their ids.
function resync(db, w, kind, items) {
  const old = new Map(db.prepare("SELECT key, id FROM node WHERE kind=?").all(kind).map((r) => [r.key, r.id]));
  for (const it of items) {
    const prev = old.get(it.key);
    if (prev) {
      w.st.delEdgesFrom.run(prev);
      w.st.ftsMemDel.run(prev);
      old.delete(it.key);
    }
    const id = w.node(kind, it.key, it.fields);
    if (it.fts) w.st.ftsMem.run(it.fts, id, kind);
    it.edges?.(id);
  }
  for (const id of old.values()) w.remove(id);
  return items.length;
}

function learnings(db, w, cwd) {
  const folded = foldLearnings(readLearnings(cwd));
  const items = folded.map((l) => ({
    key: l.key,
    fields: {
      name: l.text.slice(0, 80),
      t: epoch(l.last_verified_at),
      hash: sha(l.text),
      data: {
        key: l.key,
        keys: [...(l.keys || [])],
        id: l.id,
        text: l.text,
        refs: l.refs,
        ref_hashes: l.ref_hashes,
        sym_refs: l.sym_refs || {},
        sources: l.sources,
        corroborations: l.corroborations,
        created_at: l.created_at,
        last_verified_at: l.last_verified_at,
        legacy_unverified: l.legacy_unverified,
      },
    },
    fts: `${l.text} ${(l.refs || []).join(" ")}`,
    edges(id) {
      for (const ref of l.refs || []) {
        const [path, sym] = String(ref).split("#");
        const f = w.file(path);
        w.edge(id, EDGE.cites, f, 1);
        if (sym) {
          const s = db.prepare("SELECT id FROM node WHERE kind=? AND file_id=? AND name=?").get(KIND.symbol, f, sym);
          if (s) w.edge(id, EDGE.cites, s.id, 1);
        }
      }
      for (const src of l.sources || []) {
        const m = /^commit:([0-9a-f]{7,40})/.exec(src);
        if (m) {
          const c = db.prepare("SELECT id FROM node WHERE kind=? AND key LIKE ?").get(KIND.commit, `${m[1]}%`);
          if (c) w.edge(id, EDGE.source, c.id, 1);
        }
      }
      mentionEdges(w, id, l.text, EDGE.mentions, 0.7);
    },
  }));
  return resync(db, w, KIND.learning, items);
}

function checkpoints(db, w, cwd) {
  const key = repoKey(cwd);
  const rows = readCheckpoints(cwd).filter((c) => !c.repo_key || c.repo_key === key);
  const items = rows.map((c) => ({
    key: checkpointKey(c),
    fields: { name: String(c.task || "").slice(0, 120), t: epoch(c.created_at), data: { session_id: c.session_id, status: c.status } },
    fts: `${c.task || ""}\n${c.body_md || ""}`,
    edges(id) {
      for (const f of c.files_touched || []) w.edge(id, EDGE.touched, w.file(f), 1);
      mentionEdges(w, id, c.body_md, EDGE.mentions, 0.5);
    },
  }));
  return resync(db, w, KIND.checkpoint, items);
}

function threads(db, w, cwd) {
  const live = new Map();
  for (const r of readRows(cwd, "threads.jsonl")) {
    if (r.kind === "thread") live.set(r.id, { ...r, status: "new" });
    else if (r.ctl && live.has(r.id)) {
      const t = live.get(r.id);
      if (r.ctl === "reopen") t.status = "new";
      else if (r.ctl !== "seen") t.status = { track: "tracked", done: "done", drop: "dropped" }[r.ctl] || t.status;
    }
  }
  const items = [...live.values()].map((t) => ({
    key: String(t.id),
    fields: { name: String(t.text).slice(0, 120), t: epoch(t.at), data: { status: t.status, session: t.session, name: t.name } },
    fts: t.text,
    edges(id) {
      mentionEdges(w, id, t.text, EDGE.mentions, 0.8);
    },
  }));
  return resync(db, w, KIND.thread, items);
}

function jobs(db, w, cwd) {
  const live = new Map();
  for (const r of readRows(cwd, "jobs.jsonl")) {
    if (r.kind === "job") live.set(r.id, { ...r, status: "open" });
    else if (r.ctl && live.has(r.id)) {
      const j = live.get(r.id);
      if (r.ctl === "take") (j.status = "taken"), (j.taken_by = r.by);
      if (r.ctl === "done" || r.ctl === "decline") j.status = r.ctl === "done" ? "done" : "declined";
      if (r.ctl === "release") (j.status = "open"), (j.taken_by = undefined);
    }
  }
  const items = [...live.values()].map((j) => ({
    key: String(j.id),
    fields: { name: String(j.title || "").slice(0, 120), t: epoch(j.at), data: { status: j.status, to: j.to } },
    fts: `${j.title || ""}\n${j.detail || ""}`,
    edges(id) {
      for (const f of j.files || []) w.edge(id, EDGE.job_file, w.file(f), 1);
      for (const by of [j.from, j.taken_by]) {
        if (!by?.id) continue;
        const s = db.prepare("SELECT id FROM node WHERE kind=? AND key=?").get(KIND.session, by.id);
        if (s) w.edge(id, EDGE.assigned, s.id, 1);
      }
      mentionEdges(w, id, `${j.title} ${j.detail || ""}`, EDGE.mentions, 0.7);
    },
  }));
  return resync(db, w, KIND.job, items);
}

function decisions(db, w, root) {
  const file = join(root, "docs", "DECISIONS.md");
  const items = [];
  if (existsSync(file)) {
    const doc = w.file("docs/DECISIONS.md");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t.startsWith("|") || /^\|[\s|:-]+\|$/.test(t)) continue;
      const cells = t.split("|").slice(1, -1).map((c) => c.trim());
      if (!cells.length || /^decision$/i.test(cells[0])) continue;
      items.push({
        key: sha(t),
        fields: { name: cells[0].replace(/\*\*/g, "").slice(0, 120) },
        fts: cells.join(" "),
        edges(id) {
          w.edge(id, EDGE.decided_in, doc, 1);
          mentionEdges(w, id, t, EDGE.mentions, 0.8);
        },
      });
    }
  }
  return resync(db, w, KIND.decision, items);
}

function areas(db, w, root) {
  const list = readAreas(root);
  const files = [...w.fileIds.entries()];
  const items = list.map((a) => ({
    key: a.name,
    fields: { name: a.name, data: { docs: a.docs } },
    edges(id) {
      for (const [path, fid] of files) if (a.patterns.some((p) => p.re.test(path))) w.edge(id, EDGE.owns, fid, 1);
      for (const d of a.docs) w.edge(w.file(d), EDGE.documents, id, 1);
    },
  }));
  // Inferred areas (communities.mjs) are kept when no AREAS.md exists.
  if (!list.length) return 0;
  return resync(db, w, KIND.area, items);
}

function sessions(db, w, cwd) {
  const ck = new Map(db.prepare("SELECT key, id FROM node WHERE kind=?").all(KIND.checkpoint).map((r) => [r.key, r.id]));
  const bySession = new Map();
  for (const [key, id] of ck) {
    const sid = key.split("@")[0];
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(id);
  }
  const items = readAllStates(cwd)
    .filter(({ state }) => state.activity)
    .map(({ sessionId, state }) => {
      const a = state.activity;
      return {
        key: sessionId,
        fields: { name: a.name || sessionId.slice(0, 8), t: epoch(a.last_active), data: { role: a.role || null, task: a.task || null } },
        edges(id) {
          for (const f of Object.keys(a.files || {})) w.edge(id, EDGE.edited, w.file(f), 1);
          for (const f of Object.keys(a.planned || {})) w.edge(id, EDGE.planned, w.file(f), 0.6);
          for (const c of bySession.get(sessionId) || []) w.edge(id, EDGE.wrote, c, 1);
        },
      };
    });
  return resync(db, w, KIND.session, items);
}

// Sync every memory source whose file changed. Returns { name: rows } for what was synced.
export function syncMemory(db, w, cwd, root, { force = false } = {}) {
  const dir = dataDir(cwd);
  const sources = [
    ["learnings", join(dir, "learnings.jsonl"), () => learnings(db, w, cwd)],
    ["checkpoints", join(dir, "checkpoints.jsonl"), () => checkpoints(db, w, cwd)],
    ["threads", join(dir, "threads.jsonl"), () => threads(db, w, cwd)],
    ["decisions", join(root, "docs", "DECISIONS.md"), () => decisions(db, w, root)],
    ["areas", join(root, "docs", "AREAS.md"), () => areas(db, w, root)],
    ["sessions", join(dir, "state"), () => sessions(db, w, cwd)],
    ["jobs", join(dir, "jobs.jsonl"), () => jobs(db, w, cwd)],
  ];
  const done = {};
  for (const [name, path, fn] of sources) {
    const sig = fileSig(path);
    // Session state changes on every prompt; re-sync it at most once a minute.
    const was = metaJson(db, `sig:${name}`);
    if (!force && sameSig(was, sig) && name !== "sessions") continue;
    if (!force && name === "sessions" && Date.now() - Number(meta(db, "sessions_synced_at") || 0) < 60000) continue;
    tx(db, () => {
      done[name] = fn();
      setMeta(db, `sig:${name}`, sig);
      if (name === "sessions") setMeta(db, "sessions_synced_at", String(Date.now()));
    });
  }
  return done;
}

export { FLAG };
