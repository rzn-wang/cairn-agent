// Which files the graph knows about, and which changed since the last run.
// `git ls-files -s` gives every tracked file's blob id, so a clean file is never read to find out it didn't
// change. Untracked (not ignored) and modified files are hashed the way git would hash them.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { globRegex } from "../config.mjs";
import { ROLE } from "./schema.mjs";

const MAX_BUF = 1024 * 1024 * 1024;
function git(args, root, input) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_BUF, windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "ignore"], input });
}

export function blobSha(buf) {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

// Tracked files with their index blob ids, plus untracked ones and the set of modified paths.
export function listFiles(root, { maxUntracked = 5000 } = {}) {
  const out = new Map();
  let tracked = "";
  try {
    tracked = git(["ls-files", "-s", "-z"], root);
  } catch {
    return { files: out, dirty: new Set(), untracked: [] };
  }
  for (const rec of tracked.split("\0")) {
    // "<mode> <sha> <stage>\t<path>"; submodules (mode 160000) and conflict stages > 0 are skipped
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [mode, sha, stage] = rec.slice(0, tab).split(" ");
    if (mode === "160000" || (stage && stage !== "0")) continue;
    out.set(rec.slice(tab + 1), { sha, mode });
  }
  const dirty = new Set();
  try {
    for (const p of git(["diff", "--name-only", "-z", "HEAD"], root).split("\0")) if (p && out.has(p)) dirty.add(p);
  } catch {
    /* no HEAD yet: every tracked file is as staged */
  }
  let untracked = [];
  try {
    untracked = git(["ls-files", "-z", "--others", "--exclude-standard"], root).split("\0").filter(Boolean);
  } catch {
    /* fine */
  }
  if (untracked.length > maxUntracked) untracked = untracked.slice(0, maxUntracked);
  for (const p of untracked) out.set(p, { sha: null, mode: "100644", untracked: true });
  for (const p of dirty) out.get(p).sha = null; // the index blob isn't what's on disk: hash it
  return { files: out, dirty, untracked };
}

// Hash files whose blob id isn't known. Returns the sha, or null when unreadable / too big (size kept).
// `known` ({ size, mtimeMs, sha } from the last run) skips the read when the file hasn't been touched.
export function hashFile(root, path, maxBytes, known) {
  try {
    const st = statSync(join(root, path));
    if (known && known.sha && known.size === st.size && known.mtimeMs === Math.floor(st.mtimeMs)) return { sha: known.sha, size: st.size, mtimeMs: known.mtimeMs };
    if (!st.isFile()) return { sha: null, size: 0, missing: true };
    if (st.size > maxBytes) return { sha: `size:${st.size}:${Math.floor(st.mtimeMs)}`, size: st.size };
    return { sha: blobSha(readFileSync(join(root, path))), size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } catch {
    return { sha: null, size: 0, missing: true };
  }
}

const VENDORED = ["**/node_modules/", "vendor/", "**/vendor/", "third_party/", "**/third_party/", "external/", "Pods/", "**/Pods/", ".yarn/", "bower_components/", "**/bower_components/"].map((g) => globRegex(g));
const GENERATED_DIRS = ["dist/", "**/dist/", "build/", "**/build/", "out/", "**/out/", "target/", "**/target/", ".next/", "**/.next/", "coverage/", "**/coverage/", "**/__generated__/", "**/generated/"].map((g) => globRegex(g));
const GENERATED_NAMES = /(?:\.min\.(?:js|css)|\.map|\.pb\.go|_pb2\.py|_pb2_grpc\.py|\.g\.cs|\.designer\.cs|\.generated\.\w+|\.d\.ts\.map)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|bun\.lockb)$/i;
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|svgz|mp[34]|m4a|wav|ogg|flac|mov|avi|mkv|webm|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|a|o|obj|lib|bin|dat|db|sqlite|wasm|glb|gltf|fbx|blend|obj|stl|npy|npz|pkl|pt|onnx|parquet)$/i;
const DOC_EXT = /\.(?:md|mdx|rst|adoc|txt)$/i;
const CONFIG_NAMES = /(?:^|\/)(?:package\.json|tsconfig[\w.-]*\.json|jsconfig\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.cfg|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|Makefile|Dockerfile|[\w.-]+\.ya?ml|[\w.-]+\.toml)$/i;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|spec)\/|(?:\.|_)(?:test|spec)\.[\w]+$|(?:^|\/)test_[\w-]+\.py$|_test\.go$|(?:Tests?|Spec)\.(?:java|kt|scala|cs|php)$/;

export function compileGlobs(list) {
  return (list || []).map((g) => globRegex(g));
}

// Role from the path alone (no read). `attrs` holds linguist-generated / linguist-vendored from .gitattributes.
export function classifyPath(path, { exclude = [], include = [], attrs } = {}) {
  if (exclude.some((re) => re.test(path))) return ROLE.excluded;
  const forced = include.some((re) => re.test(path));
  if (!forced) {
    if (attrs?.vendored?.has(path) || VENDORED.some((re) => re.test(path))) return ROLE.vendored;
    if (attrs?.generated?.has(path) || GENERATED_NAMES.test(path) || GENERATED_DIRS.some((re) => re.test(path))) return ROLE.generated;
  }
  if (BINARY_EXT.test(path)) return ROLE.binary;
  if (DOC_EXT.test(path)) return ROLE.doc;
  if (TEST_PATH.test(path)) return ROLE.test;
  if (CONFIG_NAMES.test(path)) return ROLE.config;
  return ROLE.src;
}

// The first bytes of a file: NUL means binary; a "generated" marker means generated.
export function sniff(root, path) {
  let fd;
  try {
    fd = openSync(join(root, path), "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    const head = buf.subarray(0, n);
    if (head.includes(0)) return ROLE.binary;
    const text = head.subarray(0, 1024).toString("utf8");
    if (/@generated\b|Code generated .* DO NOT EDIT|<auto-generated|This file is automatically generated|DO NOT EDIT/i.test(text)) return ROLE.generated;
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// linguist-generated / linguist-vendored from .gitattributes, for the paths that have any attributes file at all.
export function linguistAttrs(root, paths) {
  const generated = new Set();
  const vendored = new Set();
  try {
    const r = spawnSync("git", ["check-attr", "-z", "--stdin", "linguist-generated", "linguist-vendored"], {
      cwd: root,
      input: paths.join("\0"),
      encoding: "utf8",
      maxBuffer: MAX_BUF,
      windowsHide: true,
    });
    const f = (r.stdout || "").split("\0");
    for (let i = 0; i + 2 < f.length; i += 3) {
      const [p, attr, val] = [f[i], f[i + 1], f[i + 2]];
      if (val === "set" || val === "true") (attr === "linguist-generated" ? generated : vendored).add(p);
    }
  } catch {
    /* attributes are a refinement */
  }
  return { generated, vendored };
}
