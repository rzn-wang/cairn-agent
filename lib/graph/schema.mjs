// Graph schema (docs/CAIRN.md "Knowledge graph"). Nodes and typed, weighted edges in two tables, plus the raw
// import specifiers (so resolution can re-run without re-reading files) and two full-text indexes.
// Any change to the shape bumps SCHEMA_VERSION: the worker then builds a new generation from scratch, which is
// safe because everything here is derived.

export const SCHEMA_VERSION = 4;

export const KIND = {
  file: 1,
  dir: 2,
  module: 3, // a workspace package or an external dependency (ext:npm:react)
  symbol: 4,
  commit: 5,
  learning: 6,
  checkpoint: 7,
  session: 8,
  thread: 9,
  job: 10,
  decision: 11,
  area: 12,
};
export const KIND_NAME = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));
// Memory: what recall ranks. Activation flows into these and stops there.
export const MEMORY = new Set([KIND.learning, KIND.checkpoint, KIND.thread, KIND.job, KIND.decision]);

export const EDGE = {
  imports: 1, // file -> file | module
  references: 2, // file -> symbol (a named import of it)
  co_changed: 3, // file <-> file (stored both ways)
  contains: 4, // dir -> file | dir
  cites: 5, // learning -> file | symbol
  mentions: 6, // memory | doc -> file | symbol
  touched: 7, // checkpoint | commit -> file
  edited: 8, // session -> file
  planned: 9, // session -> file
  wrote: 10, // session -> checkpoint
  raised: 11, // session | checkpoint -> thread
  decided_in: 12, // decision -> doc file
  owns: 13, // area -> file
  tests: 14, // test file -> file
  documents: 15, // doc file -> file
  source: 16, // learning -> commit
  assigned: 17, // job -> session
  job_file: 18, // job -> file
  in_commit: 19, // commit -> file (kept apart from `touched`, so a busy file's commits don't crowd out checkpoints)
};
export const EDGE_NAME = Object.fromEntries(Object.entries(EDGE).map(([k, v]) => [v, k]));

// File roles: only src, test, doc and config files are read and extracted. The rest stay nodes (so paths
// resolve and memory can cite them) with no edges of their own.
export const ROLE = { src: 0, test: 1, doc: 2, config: 3, generated: 4, vendored: 5, binary: 6, too_big: 7, excluded: 8 };
export const ROLE_NAME = Object.fromEntries(Object.entries(ROLE).map(([k, v]) => [v, k]));
export const FLAG = { deleted: 1, exported: 2, inferred: 4, stale: 8 };

export const DDL = `
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;

CREATE TABLE node(
  id      INTEGER PRIMARY KEY,
  kind    INTEGER NOT NULL,
  key     TEXT NOT NULL,
  name    TEXT,
  lname   TEXT,
  file_id INTEGER,
  role    INTEGER DEFAULT 0,
  lang    TEXT,
  hash    TEXT,
  hash2   TEXT,
  line    INTEGER,
  t       INTEGER,
  churn   REAL,
  deg_in  INTEGER DEFAULT 0,
  flags   INTEGER DEFAULT 0,
  data    TEXT
);
CREATE UNIQUE INDEX node_k ON node(kind, key);
CREATE INDEX node_name ON node(kind, lname);
CREATE INDEX node_owner ON node(file_id) WHERE file_id IS NOT NULL;
CREATE INDEX node_body ON node(hash2) WHERE kind = 4;

CREATE TABLE edge(
  src    INTEGER NOT NULL,
  type   INTEGER NOT NULL,
  dst    INTEGER NOT NULL,
  w      REAL NOT NULL DEFAULT 1,
  origin INTEGER,
  PRIMARY KEY(src, type, dst)
) WITHOUT ROWID;
CREATE INDEX edge_in ON edge(dst, type, w DESC, src);
CREATE INDEX edge_org ON edge(origin) WHERE origin IS NOT NULL;

CREATE TABLE spec(
  file_id  INTEGER NOT NULL,
  spec     TEXT NOT NULL,
  kind     TEXT NOT NULL,
  names    TEXT,
  resolved INTEGER,
  PRIMARY KEY(file_id, spec, kind)
) WITHOUT ROWID;
CREATE INDEX spec_unres ON spec(resolved) WHERE resolved IS NULL OR resolved = 0;

CREATE VIRTUAL TABLE fts_mem USING fts5(body, node UNINDEXED, kind UNINDEXED, tokenize="porter unicode61 tokenchars '_'");
CREATE VIRTUAL TABLE fts_ident USING fts5(words, node UNINDEXED, tokenize="unicode61 tokenchars '_'", prefix='3');
`;

export function createSchema(db) {
  db.exec(DDL);
  db.prepare("INSERT INTO meta(k,v) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  db.prepare("INSERT INTO meta(k,v) VALUES('build_state', 'building')").run();
}

// "jobBoard.ts" -> "jobboard job board ts": identifiers and paths searchable by their parts.
export function identWords(text) {
  const raw = String(text || "");
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const whole = raw.split(/[^A-Za-z0-9_]+/).filter((w) => w.length > 1).map((w) => w.toLowerCase());
  return [...new Set([...whole, ...parts])].join(" ");
}
