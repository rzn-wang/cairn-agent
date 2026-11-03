// Areas inferred from the code when the repo has no docs/AREAS.md: files that import each other and change
// together form a community (weighted label propagation, deterministic). Small communities merge into their
// strongest neighbour; one that swallows a large share of the repo is split by its top folders. Each becomes an
// area node flagged "inferred", named after its common folder and its most distinctive path words.

import { EDGE, FLAG, KIND, ROLE } from "./schema.mjs";

export function buildCommunities(db, w, { maxIter = 15, minSize = 5 } = {}) {
  const files = db
    .prepare("SELECT id, key FROM node WHERE kind=? AND (flags & ?) = 0 AND role IN (?,?,?)")
    .all(KIND.file, FLAG.deleted, ROLE.src, ROLE.test, ROLE.doc);
  const N = files.length;
  if (N < minSize * 2) return 0;
  const idx = new Map(files.map((f, i) => [f.id, i]));
  const adj = Array.from({ length: N }, () => new Map());
  const link = (a, b, wt) => {
    if (a === b) return;
    adj[a].set(b, (adj[a].get(b) || 0) + wt);
    adj[b].set(a, (adj[b].get(a) || 0) + wt);
  };
  for (const e of db.prepare("SELECT src, dst, type, w FROM edge WHERE type IN (?,?)").all(EDGE.imports, EDGE.co_changed)) {
    const a = idx.get(e.src);
    const b = idx.get(e.dst);
    if (a === undefined || b === undefined) continue;
    link(a, b, e.type === EDGE.imports ? 1 : e.w);
  }
  // A weak same-folder prior, so files with no edges still join their siblings.
  const byDir = new Map();
  files.forEach((f, i) => {
    const d = f.key.includes("/") ? f.key.slice(0, f.key.lastIndexOf("/")) : "";
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(i);
  });
  for (const list of byDir.values()) for (let k = 1; k < list.length; k++) for (let j = Math.max(0, k - 5); j < k; j++) link(list[k], list[j], 0.15);

  const label = Int32Array.from({ length: N }, (_, i) => i);
  for (let it = 0; it < maxIter; it++) {
    let changed = 0;
    for (let i = 0; i < N; i++) {
      if (!adj[i].size) continue;
      const score = new Map();
      for (const [j, wt] of adj[i]) score.set(label[j], (score.get(label[j]) || 0) + wt);
      let best = label[i];
      let bw = score.get(best) || 0;
      for (const [l, s] of score) if (s > bw || (s === bw && l < best)) (best = l), (bw = s);
      if (best !== label[i]) (label[i] = best), changed++;
    }
    if (changed < N * 0.005) break;
  }

  let groups = new Map();
  for (let i = 0; i < N; i++) {
    if (!groups.has(label[i])) groups.set(label[i], []);
    groups.get(label[i]).push(i);
  }
  // Merge the small ones into the community they're most connected to.
  for (const [l, members] of [...groups]) {
    if (members.length >= minSize) continue;
    const pull = new Map();
    for (const i of members) for (const [j, wt] of adj[i]) if (label[j] !== l) pull.set(label[j], (pull.get(label[j]) || 0) + wt);
    let target = null;
    let tw = 0;
    for (const [t, s] of pull) if (groups.has(t) && groups.get(t).length >= minSize && s > tw) (target = t), (tw = s);
    if (target === null) continue;
    for (const i of members) label[i] = target;
    groups.get(target).push(...members);
    groups.delete(l);
  }
  // Split one that holds too much of the repo by its first two folders.
  const out = [];
  for (const members of groups.values()) {
    if (members.length < minSize) continue;
    if (members.length > Math.max(200, N * 0.15)) {
      const sub = new Map();
      for (const i of members) {
        const k = files[i].key.split("/").slice(0, 2).join("/");
        if (!sub.has(k)) sub.set(k, []);
        sub.get(k).push(i);
      }
      for (const s of sub.values()) if (s.length >= minSize) out.push(s);
    } else out.push(members);
  }

  // Names: common folder + the two most distinctive words.
  const df = new Map();
  const wordsOf = (p) => new Set(p.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !/^(?:src|lib|index|test|tests|spec|mjs|tsx|jsx|cjs|py|go|rs|java|md)$/.test(x)));
  for (const f of files) for (const x of wordsOf(f.key)) df.set(x, (df.get(x) || 0) + 1);
  const named = new Map();
  const areas = out.map((members) => {
    const keys = members.map((i) => files[i].key);
    let prefix = keys[0].split("/").slice(0, -1);
    for (const k of keys) {
      const parts = k.split("/").slice(0, -1);
      let n = 0;
      while (n < prefix.length && n < parts.length && prefix[n] === parts[n]) n++;
      prefix = prefix.slice(0, n);
    }
    const tf = new Map();
    for (const k of keys) for (const x of wordsOf(k)) tf.set(x, (tf.get(x) || 0) + 1);
    const prefWords = new Set(prefix.join("/").toLowerCase().split(/[^a-z0-9]+/));
    const top = [...tf]
      .filter(([x]) => !prefWords.has(x))
      .map(([x, n]) => [x, n * Math.log(N / (df.get(x) || 1))])
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 2)
      .map(([x]) => x);
    // "packages/core/sim (jobs, board)"; at the repo root, just the words: "req, res".
    let name = prefix.length ? `${prefix.join("/")}${top.length ? ` (${top.join(", ")})` : ""}` : top.join(", ") || "root";
    while (named.has(name)) name += "'";
    named.set(name, true);
    return { name, members };
  });

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of db.prepare("SELECT id FROM node WHERE kind=? AND (flags & ?) <> 0").all(KIND.area, FLAG.inferred)) w.remove(r.id);
    for (const a of areas) {
      const id = w.node(KIND.area, `inferred:${a.name}`, { name: a.name, flags: FLAG.inferred, data: { size: a.members.length } });
      for (const i of a.members) w.edge(id, EDGE.owns, files[i].id, 1);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return areas.length;
}
