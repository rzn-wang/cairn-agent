// Markdown (and .rst/.adoc, best effort with the same rules). Links become
// imports of kind "link"; backticked paths and identifiers, and bare paths in
// prose, become mentions. Fenced code blocks are skipped: their contents are
// code samples, not references.

import { blank, each } from "./common.mjs";

const SOURCE_EXT =
  "js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte|py|go|rs|java|kt|kts|scala|cs|c|h|cc|cpp|cxx|hpp|hh|hxx|m|mm|" +
  "rb|php|md|mdx|rst|adoc|json|jsonc|yaml|yml|toml|sh|sql|css|scss|html|swift|lua|ex|exs|proto|graphql";
const RE_EXT = new RegExp(`\\.(?:${SOURCE_EXT})$`, "i");
const RE_FENCE = /^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\2[^\n]*$|(?![\s\S]))/gm;
const RE_LINK = /\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)/g;
const RE_REFDEF = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?(\S+?)>?(?:[ \t]+["'(][^\n]*)?$/gm;
const RE_CODE = /`([^`\n]+)`/g;
const RE_BARE = /(^|[\s(])((?:\.{1,2}\/)?[\w@-][\w.@-]*(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,6})(?=[\s).,;:!?]|$)/gm;

function linkTarget(raw) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("//")) return null;
  const spec = raw.split("#")[0].split("?")[0];
  return spec || null;
}

function looksPath(t) {
  if (/\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  return (t.includes("/") && /[\w]/.test(t) && !/^\/+$/.test(t)) || RE_EXT.test(t);
}

function looksIdent(t) {
  const bare = t.endsWith("()") ? t.slice(0, -2) : t;
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(bare)) return null;
  const last = bare.split(".").pop();
  if (
    t.endsWith("()") ||
    /[a-z][A-Z]/.test(last) ||
    /^[A-Z][a-z0-9]+[A-Z]/.test(last) ||
    /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(last)
  )
    return bare;
  return null;
}

export function extractMarkdown(clean, lineOf) {
  const prose = clean.replace(RE_FENCE, (m) => blank(m));
  const imports = [];
  const link = (raw, offset) => {
    const spec = linkTarget(raw);
    if (spec) imports.push({ spec, kind: "link", names: [], line: lineOf(offset) });
  };
  each(prose, RE_LINK, (m, i) => link(m[1], i));
  each(prose, RE_REFDEF, (m, i) => link(m[1], i));
  imports.sort((a, b) => a.line - b.line);

  const seen = new Set();
  const mentions = [];
  const mention = (text, kind) => {
    const key = `${kind}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    mentions.push({ text, kind });
  };
  each(prose, RE_CODE, (m) => {
    const t = m[1].trim();
    if (looksPath(t)) mention(t.replace(/^\.\//, "").replace(/[#:]L?\d+(?:-L?\d+)?$/, ""), "path");
    else {
      const id = looksIdent(t);
      if (id) mention(id, "ident");
    }
  });
  // Bare paths: prose minus code spans and link targets (those are counted above).
  const text = prose.replace(RE_CODE, (m) => blank(m)).replace(/\]\([^)\n]*\)/g, (m) => blank(m));
  each(text, RE_BARE, (m) => mention(m[2].replace(/^\.\//, ""), "path"));
  return { imports, symbols: [], mentions };
}
