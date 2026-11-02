// Prepared writes shared by the worker's phases. Worker-only: hooks never write the graph.

import { EDGE, FLAG, KIND } from "./schema.mjs";

export function writer(db) {
  const st = {
    get: db.prepare("SELECT id, hash, flags, role FROM node WHERE kind=? AND key=?"),
    upsert: db.prepare(
      `INSERT INTO node(kind,key,name,lname,file_id,role,lang,hash,hash2,line,t,flags,data)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(kind,key) DO UPDATE SET name=excluded.name, lname=excluded.lname, file_id=excluded.file_id,
         role=excluded.role, lang=excluded.lang, hash=excluded.hash, hash2=excluded.hash2, line=excluded.line,
         t=excluded.t, flags=excluded.flags, data=excluded.data
       RETURNING id`,
    ),
    insFile: db.prepare(
      `INSERT INTO node(kind,key,name,lname,role,lang,flags) VALUES(1,?,?,?,?,?,?)
       ON CONFLICT(kind,key) DO UPDATE SET flags=excluded.flags RETURNING id`,
    ),
    edge: db.prepare(
      `INSERT INTO edge(src,type,dst,w,origin) VALUES(?,?,?,?,?)
       ON CONFLICT(src,type,dst) DO UPDATE SET w=max(w, excluded.w)`,
    ),
    delEdgesFrom: db.prepare("DELETE FROM edge WHERE src=?"),
    delEdgesTo: db.prepare("DELETE FROM edge WHERE dst=?"),
    delNode: db.prepare("DELETE FROM node WHERE id=?"),
    // One text row per node, keyed by the node id as rowid: deleting by an UNINDEXED column would scan the
    // whole index on every call (quadratic builds).
    ftsMem: db.prepare("INSERT OR REPLACE INTO fts_mem(rowid, body, node, kind) VALUES(?2, ?1, ?2, ?3)"),
    ftsMemDel: db.prepare("DELETE FROM fts_mem WHERE rowid=?"),
    ftsIdent: db.prepare("INSERT OR REPLACE INTO fts_ident(rowid, words, node) VALUES(?2, ?1, ?2)"),
    ftsIdentDel: db.prepare("DELETE FROM fts_ident WHERE rowid=?"),
    byName: db.prepare("SELECT id, key FROM node WHERE kind=? AND lname=? LIMIT 50"),
  };
  const fileIds = new Map(); // repo path -> node id (filled by the inventory phase, extended on demand)

  return {
    st,
    fileIds,
    node(kind, key, f = {}) {
      return st.upsert.get(
        kind,
        key,
        f.name ?? null,
        f.name ? String(f.name).toLowerCase() : null,
        f.file_id ?? null,
        f.role ?? 0,
        f.lang ?? null,
        f.hash ?? null,
        f.hash2 ?? null,
        f.line ?? null,
        f.t ?? null,
        f.flags ?? 0,
        f.data === undefined ? null : typeof f.data === "string" ? f.data : JSON.stringify(f.data),
      ).id;
    },
    edge(src, type, dst, w = 1, origin = null) {
      if (src == null || dst == null || src === dst) return;
      st.edge.run(src, type, dst, w, origin);
    },
    // The node id of a repo file; a path the inventory doesn't know becomes a deleted file node, so memory can
    // still cite it (and recall can flag it).
    file(path) {
      if (!path) return null;
      const p = String(path).replace(/\\/g, "/").replace(/^\.\//, "");
      if (fileIds.has(p)) return fileIds.get(p);
      const got = st.get.get(KIND.file, p);
      let id = got?.id;
      if (!id) {
        const base = p.split("/").pop();
        id = st.insFile.get(p, base, base.toLowerCase(), 0, null, FLAG.deleted).id;
      }
      fileIds.set(p, id);
      return id;
    },
    // Drop a node with everything attached to it.
    remove(id) {
      st.delEdgesFrom.run(id);
      st.delEdgesTo.run(id);
      st.ftsMemDel.run(id);
      st.ftsIdentDel.run(id);
      st.delNode.run(id);
    },
  };
}

export { EDGE, KIND };
