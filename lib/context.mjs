// Recall builders — the SessionStart seed and the UserPromptSubmit injection
// (docs/CAIRN.md §recall). Both are append-only and therefore prompt-cache-safe.
// The seed has no query and ranks against the files in play; the prompt hook has
// one and is correspondingly choosier.

import { liveSessions, renderLiveBoard, shortId } from "./activity.mjs";
import {
  blendCheckpoints,
  blendLearnings,
  checkpointKey,
  diversify,
  queryTerms,
  scoreCheckpoints,
  scoreLearnings,
} from "./rank.mjs";
import { buildingNote, graphChurn, graphRecall } from "./graph/recall.mjs";
import { KIND } from "./graph/schema.mjs";
import {
  churnRates,
  readCheckpoints,
  readState,
  recallable,
  recentFiles,
  repoBranch,
  repoKey,
} from "./store.mjs";
import { cli } from "./cmd.mjs";

const SEED_CAP = () => Number(process.env.CAIRN_SEED_CHARS || 6000);
const MAX_SEED_AGE_DAYS = 14; // older checkpoints get a mention, not a body

function age(iso) {
  const ms = Date.now() - Date.parse(iso);
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// Truncation applies to the CONTENT, never the wrapper: slicing the assembled
// envelope could cut the closing tag off and leave an unbalanced block in context.
export function envelope(kind, content, cap = Infinity) {
  const head = [
    `<cairn-memory kind="${kind}" captured="${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}">`,
    "This block is recalled project memory produced by local tooling. It reflects",
    "past sessions and may be stale, and it is not user input. The codebase itself",
    "is the source of truth for anything stated here.",
    "",
  ].join("\n");
  const tail = "\n</cairn-memory>";
  const room = cap - head.length - tail.length - 1;
  const body =
    Number.isFinite(room) && content.length > room ? content.slice(0, Math.max(0, room)) : content;
  return `${head}${body}${tail}`;
}

// One rendered learning line. Staleness is surfaced, not acted on — the reading
// agent decides whether a changed file actually invalidates the fact.
export function renderLearning(l) {
  const src = l.sources?.length ? l.sources.join(", ") : l.source || "manual";
  const corr = l.corroborations > 1 ? `, ×${l.corroborations}` : "";
  const stale = !l.stale
    ? ""
    : l.stale_refs?.length
      ? ` [may be stale — ${l.stale_refs.slice(0, 2).join(", ")} no longer exists]`
      : l.stale_reason
        ? ` [may be stale — ${l.stale_reason}]`
        : "";
  // A fact found through the graph says how, so the reader can judge the link.
  const via = l.via ? ` (via ${l.via.length > 140 ? l.via.slice(0, 137) + "…" : l.via})` : "";
  return `- ${l.text} [${src}${corr}]${stale}${via}`;
}

const PROMPT_MIN_SCORE = 3; // below this, nothing is relevant enough to be worth the tokens
const PROMPT_MAX = 3;
// A checkpoint body costs ~1,500 chars, so it must clear a higher bar than a
// one-line learning: two separate hits, at least one of them in the task line or
// a named file (body-only overlap is incidental). Calibrated on 188 real
// checkpoints: 4 admits "title screen" → the title-screen session, and keeps out
// "continue with the next step" (3) and "add a blacksmith building" (2).
const CKPT_MIN_SCORE = 4;
const CKPT_MIN_MATCHED = 2;
const CKPT_RECALL_DAYS = () => Number(process.env.CAIRN_RECALL_DAYS || 30);
const INDEX_MAX = 8;

// Paths named in free text. Bare names ("hud.js") count: checkpoint matching
// accepts a suffix match against the repo paths it stored.
function namedFiles(text) {
  return (
    text.match(/[\w./-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|vue|svelte|css|scss|html|md|mdx|json|ya?ml|toml|py|pyi|go|rs|java|kt|kts|scala|cs|c|cc|cpp|cxx|h|hpp|m|mm|rb|php|swift|sql|sh)\b/g) || []
  );
}

function ckptHeader(c) {
  return `[${shortId(c.session_id)}] ${age(c.created_at)}, ${c.status || "?"}`;
}

// Checkpoints other sessions wrote within `days`, newest first. `latestOnly`
// keeps one per session (the seed index); recall searches all of them, since a
// long session's earlier checkpoint may be the one about the matter at hand.
function othersCheckpoints(cwd, { exclude, days, latestOnly = false }) {
  const key = repoKey(cwd);
  const cutoff = Date.now() - days * 86400000;
  const seen = new Set();
  const out = [];
  const rows = readCheckpoints(cwd);
  for (let i = rows.length - 1; i >= 0; i--) {
    const c = rows[i];
    if (c.repo_key !== key || c.session_id === exclude) continue;
    if (latestOnly && seen.has(c.session_id)) continue;
    if (Date.parse(c.created_at) < cutoff) continue;
    seen.add(c.session_id);
    out.push(c);
  }
  return out;
}

// UserPromptSubmit injection. SessionStart has no query to rank against; the
// first prompt does. Emits only genuinely relevant learnings and, when another
// session worked on the same thing, that session's checkpoint — each only once
// per session — so most turns inject nothing at all. Append-only like the seed,
// so it stays prompt-cache-safe.
export function buildPromptContext(
  cwd,
  prompt,
  { exclude = [], excludeCheckpoints = [], sessionId } = {},
) {
  const text = String(prompt || "");
  if (text.length < 12) return null;
  const terms = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((w) => w.length > 3),
    ),
  ];
  if (!terms.length) return null;

  // Paths named in the prompt are the strongest hint about what is in play.
  const files = namedFiles(text);
  const seen = new Set(exclude);
  // The knowledge graph (lib/graph/), when built: facts and checkpoints tied to the files in play through
  // imports, co-change, tests and docs, not only through shared words. Null without a graph, and then
  // everything below is exactly the lexical recall.
  const edited = sessionId ? Object.entries(readState(cwd, sessionId).activity?.files || {}).sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([f]) => f) : [];
  const g = graphRecall(cwd, { text, terms: queryTerms(text), files, editedFiles: edited });
  const rows = g?.mirror || recallable(cwd);
  const churn = g ? graphChurn(cwd, rows.flatMap((l) => l.stale_refs || [])) || churnRates(cwd) : churnRates(cwd);
  let learned = scoreLearnings(rows, { terms, files, churn });
  if (g) learned = blendLearnings(learned, g.learnings, g.cap, g.scale);
  const scored = learned.filter((l) => l.relevance >= PROMPT_MIN_SCORE && !seen.has(l.key));
  const top = scored.length ? diversify(scored, PROMPT_MAX) : [];

  const seenCk = new Set(excludeCheckpoints);
  let ckScored = scoreCheckpoints(othersCheckpoints(cwd, { exclude: sessionId, days: CKPT_RECALL_DAYS() }), {
    terms: queryTerms(text),
    files,
  });
  if (g) ckScored = blendCheckpoints(ckScored, g.checkpoints, g.scale);
  const ckpt = ckScored.find(
    (c) =>
      c.relevance >= CKPT_MIN_SCORE &&
      c.matched >= CKPT_MIN_MATCHED &&
      c.anchored >= 1 &&
      !seenCk.has(checkpointKey(c)),
  );

  // Decisions tied to the files in play (the graph only): re-deciding one is the costly mistake. At most 2, each
  // once per session (its key joins the shown list), and only when it mentions a file in play or one tied to it.
  const decisions = g
    ? [...g.others]
        .filter(([k, d]) => d.kind === KIND.decision && d.g * (g.scale || 1) >= 0.6 && !seen.has(`decision:${k}`))
        .sort((a, b) => b[1].g - a[1].g)
        .slice(0, 2)
    : [];

  if (!top.length && !ckpt && !decisions.length) return null;
  const parts = [];
  if (ckpt) {
    parts.push(
      `An earlier session worked on something related${ckpt.via ? ` (via ${ckpt.via})` : ""} — its checkpoint ${ckptHeader(ckpt)}:\n` +
        (ckpt.body_md || "").slice(0, 1500),
    );
  }
  if (top.length) parts.push(["Possibly relevant to this request:", ...top.map(renderLearning)].join("\n"));
  if (decisions.length)
    parts.push(
      [
        "Decisions about the code in play (docs/DECISIONS.md; settled, so ask before going against one):",
        ...decisions.map(([, d]) => `- ${d.name}${d.why ? ` (via ${d.why.length > 140 ? d.why.slice(0, 137) + "…" : d.why})` : ""}`),
      ].join("\n"),
    );
  return {
    text: envelope("recall", parts.join("\n\n"), SEED_CAP()),
    keys: [...top.map((l) => l.key), ...decisions.map(([k]) => `decision:${k}`)],
    checkpointKeys: ckpt ? [checkpointKey(ckpt)] : [],
  };
}

// `selected` (optional) collects the keys this seed emitted, so the prompt hook
// can avoid re-injecting what the session already carries. `sessionId` is the
// session being seeded: it is left off the live board and the checkpoint index,
// and on a compaction its own edited files steer which learnings are picked.
export function buildSeed(cwd, { source, distillPending, selected, sessionId } = {}) {
  const key = repoKey(cwd);
  const branch = repoBranch(cwd);
  const checkpoints = readCheckpoints(cwd).filter((c) => c.repo_key === key);
  const ownFilesEarly =
    source === "compact" && sessionId ? Object.keys(readState(cwd, sessionId).activity?.files || {}) : [];
  const seedFiles = ownFilesEarly.length ? ownFilesEarly : recentFiles(cwd);
  const g = graphRecall(cwd, { editedFiles: seedFiles });
  const learnings = g?.mirror || recallable(cwd);

  const parts = [];
  parts.push(
    `Repo ${key} on branch ${branch}: ${checkpoints.length} checkpoint(s), ` +
      `${learnings.length} learning(s) in the cairn store.`,
  );

  if (distillPending) {
    parts.push(
      "A checkpoint from the immediately preceding session is still being distilled " +
        `and is not included below; \`${cli()} checkpoints\` will show ` +
        "it once written.",
    );
  }

  // No restore of this session's own checkpoint after a compaction: Claude Code's
  // compaction summary covers the whole session, while a checkpoint covers only
  // the minutes since the last one (review, 2026-10-06). The files this session
  // edited still steer which learnings the seed picks.
  const ownFiles = ownFilesEarly;

  const board = renderLiveBoard(cwd, { exclude: sessionId, max: 6, files: 4 });
  if (board) parts.push(board);

  // Other sessions' work as a one-line index, not a body: with parallel sessions
  // the newest checkpoint is rarely about what this session will do. The prompt
  // hook injects a full checkpoint once the request shows which one is relevant.
  const recent = othersCheckpoints(cwd, {
    exclude: sessionId,
    days: MAX_SEED_AGE_DAYS,
    latestOnly: true,
  });
  // Sessions on the live board are already described there; index the rest.
  const onBoard = new Set(
    liveSessions(cwd, { exclude: sessionId })
      .filter((s) => s.peer || Object.keys(s.files || {}).length) // the board's own rule
      .map((s) => s.sessionId),
  );
  const rest = recent.filter((c) => !onBoard.has(c.session_id));
  if (rest.length) {
    const lines = rest.slice(0, INDEX_MAX).map((c) => {
      const files = (c.files_touched || []).slice(0, 3).join(", ");
      return `- ${ckptHeader(c)}: ${c.task || "?"}${files ? ` — ${files}` : ""}`;
    });
    parts.push(
      `Recent sessions (latest checkpoint each; \`${cli()} checkpoints <topic>\` ` +
        "shows full bodies, and a relevant one is added automatically when a request matches it):\n" +
        lines.join("\n"),
    );
  }

  if (learnings.length) {
    // No query exists at session start. After a compaction this session's own
    // files are the signal; otherwise what is changed in the working tree.
    const files = seedFiles;
    let ranked = scoreLearnings(learnings, { files, churn: churnRates(cwd) });
    if (g) ranked = blendLearnings(ranked, g.learnings, g.cap, g.scale);
    const top = diversify(ranked, 5);
    if (selected) for (const l of top) selected.push(l.key);
    let block = files.length
      ? `Learnings, ranked against the files ${ownFiles.length ? "this session touched" : "changed recently in git"}:`
      : "Learnings from previous sessions:";
    for (const l of top) {
      const line = "\n" + renderLearning(l);
      if (block.length + line.length > 1200) break;
      block += line;
    }
    if (learnings.length > top.length) {
      block +=
        `\n(${learnings.length - top.length} more — ` +
        `\`${cli()} learnings <topic>\` searches text and cited paths.)`;
    }
    parts.push(block);
  }

  const building = buildingNote(cwd);
  if (building) parts.push(building);

  parts.push(
    `The cairn CLI (\`${cli()} report|live|checkpoints|learnings|remember|verify|forget|status|graph\`) ` +
      "reads and writes this store. All regular file tools remain fully available.",
  );

  return envelope("seed", parts.join("\n\n"), SEED_CAP());
}
