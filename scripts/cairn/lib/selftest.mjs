// Fixture-driven end-to-end test for cairn (run: `node scripts/cairn/cairn.mjs
// selftest`). Uses an isolated store (CAIRN_DIR in a temp dir) and the
// mechanical distill engine, so it is hermetic and offline. FAIL lines + exit 1
// on any failure, matching the repo's harness style.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "transcript.jsonl");
const CLI = join(HERE, "..", "cairn.mjs");
const HOOKS = join(HERE, "..", "hooks");

let fails = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    fails++;
  }
}

function runHook(file, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [join(HOOKS, file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
  });
}

export async function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "cairn-selftest-"));
  process.env.CAIRN_DIR = dir;
  process.env.CAIRN_DISTILL = "mechanical";
  // Claude Code's session registry and plan files live under its config dir; point
  // that at the temp dir too, so the real sessions never leak into the test.
  const cfgDir = join(dir, "claude-config");
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  const env = { CAIRN_DIR: dir, CAIRN_DISTILL: "mechanical", CLAUDE_CONFIG_DIR: cfgDir };
  const cwd = process.cwd();

  // Every case works on a copy — the fixture is committed, and this suite is
  // hermetic (see the isolation check at the end).
  const fixture = join(dir, "transcript.jsonl");
  copyFileSync(FIXTURE, fixture);

  // Imports AFTER env is set so every module sees the isolated store.
  const store = await import("./store.mjs");
  const { readEvents, stats, serialize } = await import("./transcript.mjs");
  const { distillCheckpoint, parseYamlSubset } = await import("./distill.mjs");
  const { shouldDistill, writeCheckpoint, gc, segmentSince } = await import("./lifecycle.mjs");
  const { buildSeed, buildPromptContext } = await import("./context.mjs");

  // 1. transcript reader: shapes, sidechain skip, tool_result drop
  const { events, lineCount } = readEvents(fixture);
  const s = stats(events);
  check("transcript: assistant turns counted", s.assistantTurns === 6, `got ${s.assistantTurns}`);
  check(
    "transcript: edit + file captured",
    s.edits === 1 && s.filesTouched[0]?.endsWith("jobBoard.ts"),
  );
  check("transcript: sidechain skipped", !events.some((e) => e.text?.includes("sidechain")));
  check("transcript: tool results dropped", !serialize(events).includes("UNTRUSTED"));
  check("transcript: thinking dropped", !serialize(events).includes("secret reasoning"));

  // 2. boundary heuristic + mechanical distill
  check("heuristic: fixture segment distills", shouldDistill(events));
  check("heuristic: empty segment does not", !shouldDistill([]));
  const d = distillCheckpoint(events);
  check("distill: mechanical engine", d.engine === "mechanical");
  check(
    "distill: body carries task + files",
    d.body_md.includes("reservation leak") && d.body_md.includes("jobBoard.ts"),
  );

  // 3. checkpoint lifecycle: write, segment marker advances, dedupe
  const row = writeCheckpoint(cwd, { sessionId: "st-1", transcriptPath: fixture, trigger: "stop" });
  check("checkpoint: row written with branch", !!row && row.branch === store.repoBranch(cwd));
  check(
    "checkpoint: state advanced",
    store.readState(cwd, "st-1").last_checkpoint_line === lineCount,
  );
  const again = writeCheckpoint(cwd, {
    sessionId: "st-1",
    transcriptPath: fixture,
    trigger: "stop",
  });
  check("checkpoint: empty follow-up segment skipped", again === null);
  // State written before byte offsets carries only a line number: read by line once, then by byte.
  store.writeState(cwd, "st-legacy", { last_checkpoint_line: 5 });
  const legacy = segmentSince(cwd, "st-legacy", fixture);
  check(
    "checkpoint: legacy line offset still reads its segment",
    legacy.events.some((e) => e.role || e.tool) && legacy.byteCount > 0 &&
      segmentSince(cwd, "st-legacy", fixture).events.length === legacy.events.length,
  );
  store.writeState(cwd, "st-legacy", { last_checkpoint_byte: legacy.byteCount });
  check(
    "checkpoint: byte offset at the end reads nothing new",
    !segmentSince(cwd, "st-legacy", fixture).events.some((e) => e.role || e.tool),
  );

  // 4. seed: envelope + checkpoint content; disabled and pending variants
  const seed = buildSeed(cwd, { source: "startup" });
  check(
    "seed: envelope + checkpoint body",
    seed.startsWith("<cairn-memory") && seed.includes("reservation leak"),
  );
  check("seed: within budget", seed.length <= 6000);
  const pend = buildSeed(cwd, { source: "startup", distillPending: true });
  check("seed: pending distill labeled", pend.includes("still being distilled"));

  // 5. hooks piped over stdin (child processes, real exit codes)
  const sess = runHook("session_start.mjs", { session_id: "st-2", source: "startup", cwd });
  check(
    "hook session_start: exit 0 + additionalContext",
    sess.status === 0 && sess.stdout.includes("additionalContext"),
  );
  const disabled = runHook("session_start.mjs", { source: "startup", cwd }, { CAIRN_DISABLE: "1" });
  check(
    "hook session_start: CAIRN_DISABLE yields vanilla",
    disabled.status === 0 && disabled.stdout === "",
  );
  const loop = runHook("stop.mjs", { stop_hook_active: true, cwd });
  check("hook stop: loop guard silent", loop.status === 0 && loop.stdout === "");
  const stop = runHook("stop.mjs", { session_id: "st-3", transcript_path: fixture, cwd });
  check("hook stop: exit 0 + queued message", stop.status === 0 && stop.stdout.includes("queued"));
  const deadline = Date.now() + 5000; // wait for the detached distill to land
  while (store.inflightAgeMs(cwd) !== null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check(
    "hook stop: detached checkpoint landed",
    store.readCheckpoints(cwd).some((c) => c.session_id === "st-3"),
  );
  const pc = runHook("pre_compact.mjs", { session_id: "st-4", transcript_path: fixture, cwd });
  check(
    "hook pre_compact: synchronous checkpoint",
    pc.status === 0 && store.readCheckpoints(cwd).some((c) => c.session_id === "st-4"),
  );
  const garbage = runHook("stop.mjs", "not json at all", {});
  check("hook robustness: garbage stdin still exits 0", garbage.status === 0);

  // 6. learnings: remember, dedup, derived staleness, verify/forget, gc
  const scratchRel = join(".claude", "cairn-selftest-scratch.txt");
  const scratchAbs = join(store.repoRoot(cwd), scratchRel);
  writeFileSync(scratchAbs, "v1\n");
  const cli = (...a) =>
    execFileSync(process.execPath, [CLI, ...a], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  try {
    cli("remember", "The scratch file must stay ASCII.", "--ref", scratchRel);
    check("remember: learning stored", store.recallable(cwd).length === 1);
    check("learnings: text query matches", cli("learnings", "ascii").includes("ASCII"));
    // Ref-path ranking: the sentence never mentions the filename.
    check(
      "learnings: cited-path query matches",
      cli("learnings", "cairn-selftest-scratch.txt").includes("ASCII"),
    );
    // An unrelated query must NOT match (relevance, not corroboration/recency).
    check(
      "learnings: unrelated query misses",
      cli("learnings", "quaternion").includes("no matching learnings"),
    );

    // Dedup: a near-copy corroborates rather than occupying a second slot.
    const dupOut = cli("remember", "the scratch file must stay ascii", "--ref", scratchRel);
    check("remember: near-duplicate refused", dupOut.includes("already known"));
    check("remember: store still one fact", store.recallable(cwd).length === 1);

    // Unquoted sentences used to be silently truncated to the first word.
    cli("remember", "Villagers", "carry", "one", "load", "at", "a", "time.");
    check(
      "remember: unquoted sentence kept whole",
      store.recallable(cwd).some((l) => l.text === "Villagers carry one load at a time."),
    );

    // Staleness is derived from the file on disk, and never hides the fact. An
    // edit to the cited file is not staleness; the file being gone is.
    writeFileSync(scratchAbs, "v2 changed\n");
    check(
      "staleness: an edited ref does not flag",
      store.recallable(cwd).find((l) => l.text.includes("ASCII"))?.stale === false,
    );
    rmSync(scratchAbs);
    const stale = store.recallable(cwd).find((l) => l.text.includes("ASCII"));
    check("staleness: a deleted ref flags", stale?.stale === true);
    check("staleness: stale fact still recallable", store.recallable(cwd).length === 2);

    // verify re-baselines; forget is the only removal path.
    writeFileSync(scratchAbs, "v3 restored\n");
    store.verifyLearning(cwd, stale.key);
    check(
      "verify: clears the stale flag",
      store.recallable(cwd).find((l) => l.key === stale.key)?.stale === false,
    );
    store.retireLearning(cwd, stale.key, "selftest");
    check("forget: retires the fact", !store.recallable(cwd).some((l) => l.key === stale.key));
    check("forget: append-only (file grew)", store.readLearnings(cwd).length > 2);

    // gc no longer expires learnings; --compact folds the file in place.
    const before = store.recallable(cwd).length;
    gc(cwd);
    check("gc: never deletes learnings", store.recallable(cwd).length === before);
    gc(cwd, { compact: true });
    check(
      "gc --compact: folds file to distinct facts",
      store.readLearnings(cwd).length === before && store.recallable(cwd).length === before,
    );
  } finally {
    rmSync(scratchAbs, { force: true });
  }

  // 6b. fold + rank as pure functions
  const rank = await import("./rank.mjs");
  const folded = rank.foldLearnings([
    { text: "Flow fields are lazy and shared per team target", source: "commit:a", refs: ["a.ts"] },
    { text: "flow fields are lazy, shared per (team, target)", source: "commit:b", refs: ["b.ts"] },
    { text: "Villagers deliver goods on foot", source: "manual", refs: [] },
  ]);
  check("fold: near-duplicates merge", folded.length === 2);
  // The miner's commonest duplicate: the same fact restated at a different
  // length. Jaccard alone scores this 0.52 and lets the copy through.
  const subset = rank.foldLearnings([
    {
      text: "Landing thump effects (drop, squash, dust) expire silently after LANDING_TTL (2.5s) if the building mesh has not appeared; delayed creation loses the feedback",
      source: "commit:a",
      refs: [],
    },
    {
      text: "Landing thump effects expire silently after LANDING_TTL (2.5s) if building mesh has not appeared",
      source: "commit:b",
      refs: [],
    },
  ]);
  check("fold: shorter restatement folds by containment", subset.length === 1);
  check("fold: keeps the fullest phrasing", subset[0]?.text.includes("drop, squash, dust"));
  check(
    "fold: unrelated facts stay apart",
    !rank.sameFact(
      rank.tokens("Villagers carry one load at a time and drop it on abandon"),
      rank.tokens("Flow fields are lazy and shared per team target"),
    ),
  );
  const merged = folded.find((f) => f.corroborations === 2);
  check("fold: corroboration counted + refs unioned", merged?.refs.length === 2);
  const div = rank.diversify(
    rank.scoreLearnings(
      [
        { text: "one", refs: ["src/sim/a.ts"], corroborations: 1, last_verified_at: store.now() },
        { text: "two", refs: ["src/sim/b.ts"], corroborations: 1, last_verified_at: store.now() },
        { text: "three", refs: ["src/sim/c.ts"], corroborations: 1, last_verified_at: store.now() },
        {
          text: "four",
          refs: ["src/render/d.ts"],
          corroborations: 1,
          last_verified_at: store.now(),
        },
      ],
      { files: ["src/sim/a.ts"] },
    ),
    3,
  );
  check(
    "rank: diversity cap limits one subsystem",
    div.filter((l) => l.refs[0].startsWith("src/sim")).length === 2,
  );

  // --- churn-discounted stale penalty ---
  const staleRow = (refs) => ({
    text: "a fact",
    refs,
    corroborations: 1,
    last_verified_at: store.now(),
    stale: true,
    stale_refs: refs,
  });
  const scoreOf = (row, churn) =>
    rank.scoreLearnings([row], { files: row.refs, churn, now: Date.parse(row.last_verified_at) })[0]
      .score;
  // Measure the penalty as the gap to an identical non-stale row, so the test
  // does not restate the recency/corroboration tiebreakers.
  const penaltyOn = (refs, churn) => {
    const row = staleRow(refs);
    return scoreOf({ ...row, stale: false, stale_refs: [] }, churn) - scoreOf(row, churn);
  };
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const churn = new Map([
    ["src/sim/cold.ts", 0.01],
    ["src/render/hot.ts", 0.6],
  ]);
  check("churn: no churn map keeps the flat penalty", near(penaltyOn(["src/sim/cold.ts"]), 0.5));
  check(
    "churn: a hot ref is penalised far less than a cold one",
    penaltyOn(["src/render/hot.ts"], churn) < penaltyOn(["src/sim/cold.ts"], churn) - 0.2,
  );
  check(
    "churn: penalty stays within (0, 0.5]",
    penaltyOn(["src/render/hot.ts"], churn) > 0 && penaltyOn(["src/render/hot.ts"], churn) <= 0.5,
  );
  check(
    "churn: a fact about an unlisted ref keeps the full penalty",
    near(penaltyOn(["src/sim/unknown.ts"], churn), 0.5),
  );
  check(
    "churn: staleness still cannot outrank topical relevance",
    rank.scoreLearnings([staleRow(["src/sim/cold.ts"])], {
      files: ["src/sim/cold.ts"],
      churn,
    })[0].relevance === 3,
  );

  // --- miner sharding ---
  const { splitDiff, packShards, sampleShards } = await import("./distill.mjs");
  const fileDiff = (p, body) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${body}\n`;
  const bigDiff =
    fileDiff("src/a.ts", "+".repeat(100)) +
    fileDiff("src/b.ts", "+".repeat(100)) +
    fileDiff(".claude/cairn/learnings.jsonl", "+".repeat(100));
  const chunks = splitDiff(bigDiff);
  check("mine: diff splits per file", chunks.length === 3);
  check(
    "mine: split recovers the paths",
    chunks.map((c) => c.path).join(",") === "src/a.ts,src/b.ts,.claude/cairn/learnings.jsonl",
  );
  check("mine: a diff with no headers yields no chunks", splitDiff("not a diff").length === 0);
  const { mineCommit } = await import("./distill.mjs");
  const storeOnly = mineCommit("msg", fileDiff(".claude/cairn/learnings.jsonl", "+x"));
  check(
    "mine: an all-filtered diff mines nothing (no store feedback loop)",
    storeOnly.items.length === 0 && storeOnly.shards === 0,
  );
  const packed = packShards(chunks, 200);
  check(
    "mine: packing respects the char budget",
    packed.every((s) => s.reduce((n, c) => n + c.text.length, 0) <= 200 || s.length === 1),
  );
  check("mine: packing keeps every file", packed.flat().length === 3);
  check(
    "mine: an oversized single file is truncated, not dropped",
    packShards([{ path: "x", text: "y".repeat(500) }], 200)[0][0].text.length === 200,
  );
  const many = Array.from({ length: 20 }, (_, i) => [{ path: `f${i}`, text: "z" }]);
  const sampled = sampleShards(many, 8);
  check("mine: sampling honours the shard cap", sampled.length === 8);
  check("mine: sampling spans the whole commit", sampled[0] === many[0] && sampled[7] === many[19]);
  check("mine: sampling is a no-op under the cap", sampleShards(many.slice(0, 5), 8).length === 5);

  // 6c. prompt-time injection
  const ups = runHook(
    "user_prompt_submit.mjs",
    { session_id: "st-5", cwd, prompt: "Villagers carry loads — how does that work?" },
    env,
  );
  check(
    "hook user_prompt_submit: injects on a relevant prompt",
    ups.status === 0 && ups.stdout.includes("Villagers carry one load"),
  );
  const upsQuiet = runHook(
    "user_prompt_submit.mjs",
    { session_id: "st-6", cwd, prompt: "what time is it" },
    env,
  );
  check(
    "hook user_prompt_submit: recalls nothing when nothing is relevant (only the feature-request reminder)",
    upsQuiet.status === 0 && !upsQuiet.stdout.includes('kind=\\"recall\\"') && upsQuiet.stdout.includes('kind=\\"rule\\"'),
  );

  // 6d. live board: who is working on what, in which files
  const act = await import("./activity.mjs");
  const root = store.repoRoot(cwd);
  const shopAbs = join(root, "scripts", "stui", "shop.js");
  act.touch(cwd, "st-live-a", { prompt: "Rework the shop panel layout and icons\nmore detail" });
  act.touch(cwd, "st-live-a", { file: act.repoPath(cwd, shopAbs) });
  check("live: repoPath relativizes", act.repoPath(cwd, shopAbs) === "scripts/stui/shop.js");
  check("live: out-of-repo path ignored", act.repoPath(cwd, join(tmpdir(), "x.md")) === null);
  check(
    "live: short prompt is not a task",
    act.touch(cwd, "st-live-c", { prompt: "go for it" }).activity.task === undefined,
  );
  check(
    "live: session listed for others",
    act.liveSessions(cwd, { exclude: "st-live-b" }).some((s) => s.sessionId === "st-live-a"),
  );
  check(
    "live: session not listed for itself",
    !act.liveSessions(cwd, { exclude: "st-live-a" }).some((s) => s.sessionId === "st-live-a"),
  );
  const board = act.renderLiveBoard(cwd, { exclude: "st-live-b" });
  check(
    "live: board shows task + files",
    board.includes("Rework the shop panel") && board.includes("scripts/stui/shop.js"),
  );
  store.writeState(cwd, "st-live-old", {
    activity: { last_active: "2020-01-01T00:00:00Z", task: "ancient work", files: {} },
  });
  check("live: idle session drops off", !act.renderLiveBoard(cwd, {}).includes("ancient work"));

  const edit = (session, file, tool = "Edit") =>
    runHook(
      "post_tool_use.mjs",
      { session_id: session, cwd, tool_name: tool, tool_input: { file_path: file } },
      env,
    );
  const overlap = edit("st-live-b", shopAbs);
  check(
    "hook post_tool_use: warns on overlap with a live session",
    overlap.status === 0 &&
      overlap.stdout.includes("additionalContext") &&
      overlap.stdout.includes("Rework the shop panel"),
  );
  check("hook post_tool_use: warns once per file + session", edit("st-live-b", shopAbs).stdout === "");
  const hudEdit = edit("st-live-b", join(root, "scripts", "stui", "hud.js")).stdout;
  check("hook post_tool_use: no warning on an unshared file", !hudEdit.includes('kind=\\"overlap\\"'));
  // Area nudge (docs/AREAS.md): once per area per session, naming the area and its doc status.
  // The area names come from the real repo's AREAS.md; without one, no nudge may fire.
  check(
    "hook post_tool_use: first edit in an area names it",
    existsSync(join(root, "docs", "AREAS.md"))
      ? overlap.stdout.includes('kind=\\"area\\"') && overlap.stdout.includes("Economy & shops") &&
          hudEdit.includes("HUD & menus")
      : !overlap.stdout.includes('kind=\\"area\\"') && !hudEdit.includes('kind=\\"area\\"'),
  );
  check(
    "hook post_tool_use: area nudge once per area",
    edit("st-live-b", join(root, "scripts", "stui", "shopPanel.js")).stdout === "",
  );
  check(
    "hook post_tool_use: records the edit",
    !!store.readState(cwd, "st-live-b").activity?.files?.["scripts/stui/hud.js"],
  );
  check("hook post_tool_use: ignores non-edit tools", edit("st-live-d", shopAbs, "Read").stdout === "");
  check(
    "seed: live board included, own session left off",
    (() => {
      const s = buildSeed(cwd, { source: "startup", sessionId: "st-live-b" });
      return s.includes("Other sessions active") && s.includes("Rework the shop panel");
    })(),
  );

  // 6d2. names and status from Claude Code's registry; plans; the report
  check("names: no registry falls back to the short id", act.who({ sessionId: "st-live-a-long" }) === "st-live-");
  mkdirSync(join(cfgDir, "sessions"), { recursive: true });
  mkdirSync(join(cfgDir, "plans"), { recursive: true });
  writeFileSync(
    join(cfgDir, "sessions", "101.json"),
    JSON.stringify({ sessionId: "st-live-a", cwd: root.replace(/\//g, "\\").toLowerCase(), name: "Shop", status: "waiting" }),
  );
  writeFileSync(join(cfgDir, "sessions", "102.json"), "{ half written");
  check(
    "names: board shows registry name and status",
    act.renderLiveBoard(cwd, { exclude: "st-live-b" }).includes("[Shop · st-live-] waiting"),
  );
  check(
    "names: harness wrapper is not a task",
    act.promptTask("<ide_opened_file>The user opened the file a.md in the IDE.</ide_opened_file>\nmake the shop panel scroll") ===
      "make the shop panel scroll" &&
      act.promptTask("<ide_opened_file>The user opened the file a.md.</ide_opened_file>\ngo") === null,
  );
  check(
    "recall: machine prompts and the IDE's open-file line are not searched",
    act.humanText("<task-notification><task-id>x</task-id></task-notification>") === null &&
      act.humanText("Another Claude session sent a message while you were working: hi") === null &&
      act.humanText("<ide_opened_file>The user opened the file plans/x.md</ide_opened_file>\nand?") === "and?",
  );
  const planText =
    "# Plan\n\nSee `scripts/stui/hud.js` for context.\n\n## Files\n\n- **Edit:** `scripts/stui/shop.js`, `shopPanel.js`\n" +
    "- **Reuse:**\n  - `scripts/stui/theme.js`\n- New: `scripts/stui/shop/`\n- Reads `src/render/` and `ui/shorthand.js`\n\n## Checks\n- `scripts/stui/other.js`\n";
  const planned = act.planPaths(cwd, planText);
  check(
    "plan: paths from the Files section, bare names resolved, reuse skipped",
    ["scripts/stui/shop.js", "scripts/stui/shopPanel.js", "scripts/stui/shop/"].every((p) => planned.includes(p)) &&
      !planned.some((p) => /hud|theme|other|shorthand|^src\/render\/$/.test(p)),
    planned.join(", "),
  );
  const planFile = join(cfgDir, "plans", "st-plan.md");
  writeFileSync(planFile, planText);
  const planHook = runHook(
    "post_tool_use.mjs",
    { session_id: "st-live-p", cwd, tool_name: "Write", tool_input: { file_path: planFile, content: planText } },
    env,
  );
  const pAct = store.readState(cwd, "st-live-p").activity || {};
  check(
    "plan: write records planned paths, not edited files",
    !!pAct.planned?.["scripts/stui/shop.js"] && !Object.keys(pAct.files || {}).length,
  );
  check(
    "plan: names the live session already editing a planned path",
    planHook.stdout.includes("plan-overlap") && planHook.stdout.includes("Shop · st-live-"),
  );
  check(
    "plan: editing a planned file warns the editor",
    edit("st-live-q", join(root, "scripts", "stui", "shop", "list.js")).stdout.includes("plans to edit it"),
  );
  const pre = (session, file) =>
    runHook(
      "pre_tool_use.mjs",
      { session_id: session, cwd, tool_name: "Edit", tool_input: { file_path: file } },
      env,
    );
  const held = pre("st-pre", shopAbs);
  check(
    "hold: first edit of a file an open session edited is held once, naming it",
    held.status === 0 && held.stdout.includes('"deny"') && held.stdout.includes("Shop · st-live-"),
  );
  check("hold: the same edit again goes through", pre("st-pre", shopAbs).stdout === "");
  check("hold: never answers allow", !held.stdout.includes('"allow"'));
  check(
    "hold: a file only a closed session edited is not held",
    pre("st-pre2", join(root, "scripts", "stui", "hud.js")).stdout === "",
  );
  // 6d3. roles, who, jobs and the message log
  check(
    "role: read from how the person introduced the session",
    act.promptRole("hi, ur the lore manager") === "lore manager" && act.promptRole("what is ur cutoff date") === null,
  );
  cli("role", "shop and prices", "--as", "st-live-a");
  check("role: set by command", store.readState(cwd, "st-live-a").activity?.role === "shop and prices");
  const { whoFor } = await import("./report.mjs");
  const whoShop = whoFor(cwd, "the prices are wrong");
  check("who: finds the session by its role", whoShop[0]?.s.sessionId === "st-live-a", JSON.stringify(whoShop.map((r) => r.why)));
  check(
    "who: finds the session by a file it edited",
    whoFor(cwd, "scripts/stui/shop.js")[0]?.s.sessionId === "st-live-a",
  );
  const J = await import("./jobs.mjs");
  const asker = { id: "st-asker", name: "Asker" };
  const j1 = J.addJob(cwd, { from: asker, to: "prices", title: "Fix the tier two price", files: ["scripts/stui/shop.js"] });
  const shopSelf = J.me(cwd, "st-live-a");
  check(
    "jobs: a job to a role reaches the session with that role",
    shopSelf.name === "Shop" && J.jobsFor(cwd, shopSelf).some((j) => j.id === j1.id),
  );
  check(
    "jobs: roles match on whole words",
    !J.addressedTo({ to: "art" }, { name: "x", role: "character modeler" }) &&
      J.addressedTo({ to: "water" }, { name: "x", role: "water and sea" }),
  );
  const prompt = (session, text) =>
    runHook("user_prompt_submit.mjs", { session_id: session, cwd, prompt: text }, env);
  const delivered = prompt("st-live-a", "carry on with the panel please");
  check(
    "jobs: delivered on the next prompt, once",
    delivered.stdout.includes("Fix the tier two price") &&
      !prompt("st-live-a", "and the next part please").stdout.includes("Fix the tier two price"),
  );
  J.updateJob(cwd, j1.id, "take", { id: "st-live-a", name: "Shop" });
  J.updateJob(cwd, j1.id, "done", { id: "st-live-a", name: "Shop" }, "price fixed");
  check(
    "jobs: the asker hears it was done",
    prompt("st-asker", "what is next on the list").stdout.includes("price fixed"),
  );
  runHook(
    "post_tool_use.mjs",
    { session_id: "st-live-a", cwd, tool_name: "SendMessage", tool_input: { to: "Bob", message: "Can you check the shop?\nmore" } },
    env,
  );
  runHook(
    "post_tool_use.mjs",
    { session_id: "st-live-a", cwd, tool_name: "SendMessage", tool_input: { to: "Cleo", message: "Heads up. No reply needed." } },
    env,
  );
  const later = Date.now() + 20 * 60000;
  const waiting = J.unanswered(cwd, { nowMs: later });
  check(
    "messages: a sent message with no reply is listed, an FYI is not",
    waiting.some((m) => m.to === "Bob" && m.line === "Can you check the shop?") && !waiting.some((m) => m.to === "Cleo"),
  );
  prompt("st-live-a", '<cross-session-message from="uds:x" from-name="Bob">Checked, all fine.</cross-session-message>');
  check(
    "messages: a reply clears it",
    !J.unanswered(cwd, { nowMs: later }).some((m) => m.to === "Bob"),
  );
  // a message after Claude Code's preamble line is still logged; a reply from a renamed session still counts
  prompt(
    "st-live-a",
    'Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="Zed">Zed checking in on the map</cross-session-message>',
  );
  check(
    "messages: logged when a preamble comes first",
    J.readMessages(cwd).some((m) => m.dir === "received" && m.from === "Zed" && m.line === "Zed checking in on the map"),
  );
  J.logMessage(cwd, { dir: "sent", from: "OldName", to: "Yan", text: "Can you look at the rivers?", fromId: "st-ren-a", toId: "st-ren-b" });
  J.logMessage(cwd, { dir: "sent", from: "Yan", to: "NewName", text: "Rivers look right to me.", fromId: "st-ren-b", toId: "st-ren-a" });
  check(
    "messages: a reply to a renamed session clears it (matched by session id)",
    !J.unanswered(cwd, { nowMs: Date.now() + 20 * 60000 }).some((m) => m.line === "Can you look at the rivers?"),
  );

  // a taken job can be handed back; a quiet one shows as stale; "done" reports don't wait for a reply
  const j2 = J.addJob(cwd, { from: asker, to: "prices", title: "Retune the stockfish price" });
  J.updateJob(cwd, j2.id, "take", { id: "st-live-a", name: "Shop" });
  check(
    "jobs: a released job goes back to open, unowned",
    J.updateJob(cwd, j2.id, "release", { id: "st-live-a", name: "Shop" }, "moved to other work")?.status === "open",
  );
  J.updateJob(cwd, j2.id, "take", { id: "st-live-a", name: "Shop" });
  check(
    "jobs: a taken job with no update for 3 h is stale",
    J.staleJobs(cwd, { nowMs: Date.now() + 4 * 3600000 }).some((j) => j.id === j2.id) &&
      !J.staleJobs(cwd).some((j) => j.id === j2.id),
  );
  J.updateJob(cwd, j2.id, "done", { id: "st-live-a", name: "Shop" }, "retuned");
  runHook(
    "post_tool_use.mjs",
    { session_id: "st-live-a", cwd, tool_name: "SendMessage", tool_input: { to: "Dana", message: "Job #9 done: the price is fixed." } },
    env,
  );
  check(
    "messages: a 'done' report isn't listed as waiting for a reply",
    !J.unanswered(cwd, { nowMs: Date.now() + 20 * 60000 }).some((m) => m.to === "Dana"),
  );

  // plan first: every prompt Robin wrote carries the reminder to check it for feature requests; a machine one doesn't
  check(
    "plan first: Robin's prompts carry the feature-request reminder, other sessions' messages don't",
    prompt("st-live-a", "the harbour toll panel could show last year too").stdout.includes("Open decisions") &&
      !prompt("st-live-a", '<cross-session-message from="uds:x" from-name="Bob">add a toll panel</cross-session-message>').stdout.includes("Open decisions"),
  );

  // waiting on Robin: a reply that ends by saying the session waits on him is sent back to ask; a report about others isn't
  const { waitingOnRobin } = await import("./ask.mjs");
  check(
    "ask: 'still waiting on you' endings found, reports about other sessions not",
    waitingOnRobin("Done the merge.\n\nStill waiting on you: the Riftlands names.").length === 1 &&
      waitingOnRobin("**Open:** blocked on your call about the toll rate.").length === 1 &&
      waitingOnRobin("The board shows the tuning agent as waiting on you.").length === 0 &&
      waitingOnRobin("The caravan waits for the tide.").length === 0 &&
      waitingOnRobin('- It catches closing lines such as "Still waiting on you: …" and `blocked on your call`.').length === 0 &&
      waitingOnRobin("The master's share of a place's earnings is your decision.").length === 1 &&
      waitingOnRobin("Each needs its own plan and your answers before I build it.").length === 1 &&
      waitingOnRobin("Removed: the monthly murder roll, as you decided.").length === 0,
  );

  // threads: a reply's Open list is parsed, near-copies fold, a closed thread raised again reopens, systems sees new ones once
  const TH = await import("./threads.mjs");
  const items = TH.openItems(
    "Done.\n\n**Removed or deprecated:** nothing.\n\n**Still open**\n- Job #71: moving Varathe west.\n- Varathe's origin is still to write.\n\nOpen the panel to see it.\n\n**Open:** nothing.",
  );
  check("threads: an Open list is read, sentences and 'nothing' are not", items.length === 2 && items[0].startsWith("Job #71"), JSON.stringify(items));
  TH.addThreads(cwd, items, { session: "st-th-a", name: "Mapper", role: "world generator" });
  TH.addThreads(cwd, ["Job #71: moving Varathe to the west"], { session: "st-th-b" });
  const th = TH.readThreads(cwd);
  check("threads: a near-copy folds into the first", th.length === 2 && th[0].mentions === 2, JSON.stringify(th.map((t) => t.text)));
  TH.setThread(cwd, th[1].id, "done", "Systems", "origin written");
  TH.addThreads(cwd, ["Varathe's origin is still to write."], { session: "st-th-a", at: new Date(Date.now() + 1000).toISOString() });
  check("threads: a closed thread raised again opens again", TH.readThreads(cwd)[1].status === "new");
  act.touch(cwd, "st-sys", { role: "systems" });
  const sysFirst = prompt("st-sys", "carry on with the register").stdout;
  check(
    "threads: the systems session is shown new threads once, other sessions never",
    sysFirst.includes("new open thread") && !prompt("st-sys", "and again").stdout.includes("new open thread") &&
      !prompt("st-live-a", "keep going").stdout.includes("new open thread"),
  );

  // tuning: a non-tuning session's first edit to a check is held, a repeat goes through, the tuning agent is never held
  const editCheck = (session, file) =>
    runHook("pre_tool_use.mjs", { session_id: session, cwd, tool_name: "Edit", tool_input: { file_path: file } }, env).stdout;
  act.touch(cwd, "st-tune-feat", { role: "world generator" });
  act.touch(cwd, "st-tune-agent", { role: "tuning" });
  const gateAbs = join(root, "src", "sim", "engine", "gate.ts");
  check(
    "tuning: a feature session's first edit to a gate file is held, the repeat goes through",
    editCheck("st-tune-feat", gateAbs).includes("tuning agent") && !editCheck("st-tune-feat", gateAbs).includes("tuning agent"),
  );
  check(
    "tuning: a worktree's copy of the sweep is held too; the tuning agent is never held",
    editCheck("st-tune-feat", "C:/tmp/wt/tools/worldgen-sweep.mjs").includes("tuning agent") &&
      !editCheck("st-tune-agent", gateAbs).includes("tuning agent") &&
      !editCheck("st-tune-feat", join(root, "src", "sim", "engine", "powers", "state.ts")).includes("tuning agent"),
  );

  // overview: built from the board and the queue, embedded in the page without breaking out of its script tag
  const ov = await import("./overview.mjs");
  const data = ov.buildOverview(cwd);
  const page = ov.renderOverviewHtml({ ...data, notes: "</script><b>x</b>" });
  check(
    "overview: sessions and jobs gathered, page embeds the data safely",
    Array.isArray(data.sessions) && Array.isArray(data.unheld) && page.includes("\u003c/script>") && !page.includes("/*OVERVIEW_DATA*/"),
  );

  // a job shows its holder's name as it is now, read by session id (Claude Code renames sessions and reuses names)
  const jRen = J.addJob(cwd, { from: asker, to: "prices", title: "Rename check" });
  J.updateJob(cwd, jRen.id, "take", { id: "st-live-a", name: "OldNameNowReused" });
  check(
    "jobs: the holder's current name is shown, not the name it had when it took the job",
    J.readJobs(cwd).find((j) => j.id === jRen.id)?.taken_by?.name === "Shop",
  );
  J.updateJob(cwd, jRen.id, "done", { id: "st-live-a", name: "Shop" }, "test");

  // load: a session holding LOAD jobs while an idle open session of its role holds none is flagged in the report
  const loadReg = [["103.json", "st-load-busy", "busy"], ["104.json", "st-load-idle", "idle"]];
  for (const [file, id, status] of loadReg) {
    writeFileSync(
      join(cfgDir, "sessions", file),
      JSON.stringify({ sessionId: id, cwd: root.replace(/\//g, "\\").toLowerCase(), name: id, status }),
    );
    act.touch(cwd, id, { role: "mapmaker" });
  }
  const loadJobs = Array.from({ length: J.LOAD }, (_, i) => J.addJob(cwd, { from: asker, to: "mapmaker", title: `Map job ${i}` }));
  for (const j of loadJobs) J.updateJob(cwd, j.id, "take", { id: "st-load-busy", name: "st-load-busy" });
  check(
    "load: an overloaded session beside an idle one of its role is flagged",
    J.loadOf(cwd).flags.some((f) => f.includes(`holds ${J.LOAD} jobs`) && f.includes("st-load-idle")) &&
      J.renderQueue(cwd).includes("## Load: hand work over"),
  );
  J.updateJob(cwd, loadJobs[0].id, "release", { id: "st-load-busy", name: "st-load-busy" }, "handed over");
  J.updateJob(cwd, loadJobs[0].id, "take", { id: "st-load-idle", name: "st-load-idle" });
  check("load: no flag once the idle session holds a job", !J.loadOf(cwd).flags.length);
  for (const j of loadJobs) J.updateJob(cwd, j.id, "done", { id: "st-load-busy", name: "st-load-busy" }, "test");
  for (const [file] of loadReg) rmSync(join(cfgDir, "sessions", file), { force: true });

  // notice board and message rules
  J.addNotice(cwd, { from: asker, text: "Build is red until the sea shader lands" });
  const boardShown = prompt("st-live-a", "keep going with the shop");
  check(
    "notices: shown to other sessions once, never to the poster",
    boardShown.stdout.includes("Build is red") &&
      !prompt("st-live-a", "and again please").stdout.includes("Build is red") &&
      !prompt("st-asker", "anything new on the board").stdout.includes("Build is red"),
  );
  const send = (message, to = "Bob") =>
    runHook(
      "pre_tool_use.mjs",
      { session_id: "st-live-a", cwd, tool_name: "SendMessage", tool_input: { to, message } },
      env,
    );
  const longMsg = "Spec:\n" + "x".repeat(1300);
  check("message rule: a long message is held once", send(longMsg).stdout.includes("deny") && send(longMsg).stdout === "");
  check("message rule: a bare thank-you is held", send("Thanks, got it.").stdout.includes("thank-you"));
  check("message rule: an ordinary message passes", send("Can you move the jetty 2 m east? It blocks the stair.").stdout === "");
  // questions left in prose are sent back once to be asked with AskUserQuestion
  const turn = (text, tool) =>
    [
      { type: "user", message: { role: "user", content: "set up https for me" } },
      ...(tool ? [{ type: "assistant", message: { content: [{ type: "tool_use", name: tool, input: {} }] } }] : []),
      { type: "assistant", message: { content: [{ type: "text", text }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
  const askFile = join(dir, "ask.jsonl");
  const stopOn = (text, tool, extra = {}) => {
    writeFileSync(askFile, turn(text, tool));
    return runHook("stop.mjs", { session_id: "st-ask", transcript_path: askFile, cwd, ...extra }, env).stdout;
  };
  const asking = "Two ways to do it.\n\n1. Tailscale.\n2. Self-signed.\n\nWhich device are you testing from? I'll set it up.";
  check("ask: a reply ending with a question for Robin is sent back", stopOn(asking).includes('"block"'));
  check("ask: not when the turn already used AskUserQuestion", !stopOn(asking, "AskUserQuestion").includes('"block"'));
  check("ask: never twice in a row (stop_hook_active)", !stopOn(asking, null, { stop_hook_active: true }).includes('"block"'));
  check(
    "ask: a plain report is left alone",
    !stopOn("Why did it fail? The cache was stale.\nFixed it; the tests pass.\nAll done.").includes('"block"'),
  );
  const leaveOut = stopOn("Step 2 is done and the tests pass.\nNext is step 3.\n\nShould I go ahead with step 3?");
  check(
    "ask: asking leave to carry on is sent back to keep working, not to the question box",
    leaveOut.includes('"block"') && leaveOut.includes("keep working") && !leaveOut.includes("Your reply ends with"),
  );
  const box = (questions) =>
    runHook(
      "pre_tool_use.mjs",
      { session_id: "st-box", cwd, tool_name: "AskUserQuestion", tool_input: { questions: questions.map((q) => ({ question: q })) } },
      env,
    ).stdout;
  check(
    "ask: a box that only asks leave is held once, then goes through",
    box(["What should I do next?"]).includes("deny") && box(["What should I do next?"]) === "",
  );
  check("ask: a box with a real decision is never held", box(["Should the oil start at 30 instead of 60?"]) === "");
  // heavy runs: classified from the command text, so the queue knows what to ration
  const H = await import("./heavy.mjs");
  check(
    "heavy: direct heavy runs are recognised; queued tests, light commands and mere mentions are not",
    H.classify("pnpm shot -- --views a", root) === "browser" &&
      H.classify("cd x && node tools/simtest.mjs > /tmp/s.txt", root) === "simtest" &&
      H.classify("pnpm build:kit", root) === "blender" &&
      H.classify("pnpm playtest", root) === null && // the test queue rations these
      H.classify("pnpm -s simtest", root) === null &&
      H.classify("pnpm build", root) === null &&
      H.classify("grep -n x tools/simtest.mjs", root) === null &&
      H.classify("git status && node scripts/cairn/cairn.mjs report", root) === null,
  );
  check("heavy: limits can be raised by env", (process.env.CAIRN_MAX_BROWSER = "5") && H.limit("browser") === 5);
  {
    const sim = (pid, ppid, heap = "") => ({ name: "node.exe", cmd: `node ${heap}C:/repo/tools/simtest.mjs`, pid: String(pid), ppid: String(ppid) });
    check(
      "heavy: a simtest that re-spawns itself with a bigger heap counts once; two runs count twice; a direct big-heap test script counts too",
      H.tally([sim(10, 1), sim(11, 10, "--max-old-space-size=8192 ")]).simtest === 1 &&
        H.tally([sim(10, 1), sim(11, 10, "--max-old-space-size=8192 "), sim(20, 2), sim(21, 20, "--max-old-space-size=8192 ")]).simtest === 2 &&
        H.tally([{ name: "node.exe", cmd: "node --max-old-space-size=8192 tools/out/simone.mjs p", pid: "30", ppid: "3" }]).simtest === 1 &&
        H.classify("node --max-old-space-size=8192 ../some.mjs wt engine-holding.test.mjs", cwd) === "simtest",
    );
  }
  delete process.env.CAIRN_MAX_BROWSER;
  // the shared test queue: three sessions asking at once share one run; asking again on unchanged files reuses it
  const { spawn: spawnAsync } = await import("node:child_process");
  const askQueue = () =>
    new Promise((resolve) => {
      const p = spawnAsync(process.execPath, [join(HERE, "..", "test.mjs"), "dummy"], {
        env: { ...process.env, ...env, CAIRN_TESTQ_DUMMY: "1", CAIRN_MAX_BUILD: "9", CLAUDE_CODE_SESSION_ID: "" },
      });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("exit", (code) => resolve({ out, code }));
    });
  const three = await Promise.all([askQueue(), askQueue(), askQueue()]);
  const qdir = join(dir, "tests");
  const { readdirSync } = await import("node:fs");
  const runCount = existsSync(qdir)
    ? readdirSync(qdir).flatMap((d) => readdirSync(join(qdir, d))).filter((f) => f.endsWith(".json")).length
    : 0;
  check(
    "test queue: three requests at once share one run and all get its output",
    three.every((r) => r.code === 0 && r.out.includes("dummy ran")) && runCount === 1,
    `runs ${runCount}, outputs ${three.map((r) => r.out.trim()).join(" / ")}`,
  );
  const fourth = await askQueue();
  check("test queue: a later request on unchanged files reuses the finished run", fourth.out.includes("dummy ran"));
  const { renderReport } = await import("./report.mjs");
  const rep = renderReport(cwd);
  check(
    "report: waiting session and shared path listed",
    rep.includes("waiting on a human: Shop · st-live-") && /scripts\/stui\/shop\.js: .*Shop · st-live-/.test(rep),
  );

  // 6e. checkpoint recall: another session's checkpoint arrives when a request matches it
  store.addCheckpoint(cwd, {
    repo_key: store.repoKey(cwd),
    session_id: "st-ck",
    branch: store.repoBranch(cwd),
    created_at: store.now(),
    trigger: "stop",
    engine: "mechanical",
    task: "Fix the Gloom ring shader flicker at night",
    status: "in_progress",
    body_md: "**Task:** Fix the Gloom ring shader flicker at night\n**Open threads:**\n- depth fade still bands",
    files_touched: ["client/render/fx/gloom.js"],
    open_threads: ["depth fade still bands"],
  });
  const ask = "the gloom ring flickers at night again, can you look at gloom.js";
  const recall = buildPromptContext(cwd, ask, { sessionId: "st-other" });
  check(
    "recall: matching checkpoint injected",
    recall?.checkpointKeys?.length === 1 && recall.text.includes("depth fade still bands"),
  );
  check(
    "recall: checkpoint injected once per session",
    !buildPromptContext(cwd, ask, {
      sessionId: "st-other",
      excludeCheckpoints: recall?.checkpointKeys || [],
    })?.checkpointKeys?.length,
  );
  check(
    "recall: own checkpoint not re-injected",
    !buildPromptContext(cwd, ask, { sessionId: "st-ck" })?.checkpointKeys?.length,
  );
  check(
    "recall: unrelated request gets no checkpoint",
    !buildPromptContext(cwd, "tune the shop prices for tier two items", { sessionId: "st-other" })
      ?.checkpointKeys?.length,
  );
  check(
    "seed: other sessions indexed one line each",
    buildSeed(cwd, { source: "startup", sessionId: "st-other" }).includes(
      "Fix the Gloom ring shader flicker at night",
    ),
  );

  // 6f. stop hook contract
  // The Review gate is retired: a substantial turn checkpoints and ends, never
  // continuing the conversation to ask for a verdict.
  check(
    "hook stop: substantial turn does not ask for a review verdict",
    !stop.stdout.includes("AskUserQuestion") && !stop.stdout.includes("additionalContext"),
  );
  // A stop reached from some other hook's continuation must still checkpoint.
  const contd = runHook(
    "stop.mjs",
    { session_id: "st-11", transcript_path: fixture, cwd, stop_hook_active: true },
    env,
  );
  check(
    "hook stop: continuation still checkpoints",
    contd.stdout.includes("queued") && !contd.stdout.includes("AskUserQuestion"),
  );

  // 7. yaml subset parser
  const doc = parseYamlSubset(
    "task: fix the leak\nstatus: done\nfiles_touched: [a.ts, b.ts]\ndecisions:\n  - released on abandon\nopen_threads: []",
  );
  check(
    "yaml: checkpoint shape",
    doc.task === "fix the leak" &&
      doc.files_touched.length === 2 &&
      doc.decisions[0].includes("abandon"),
  );
  const mined = parseYamlSubset(
    "- text: fact one\n  refs: [src/a.ts]\n- text: fact two\n  refs: []",
  );
  check("yaml: miner shape", mined.length === 2 && mined[1].text === "fact two");
  check(
    "yaml: [] literal",
    Array.isArray(parseYamlSubset("[]")) && parseYamlSubset("[]").length === 0,
  );
  let threw = false;
  try {
    parseYamlSubset("::: total garbage {");
  } catch {
    threw = true;
  }
  check("yaml: garbage throws (caller falls back)", threw);

  // 7b. mining a store-only commit is refused (it would re-mine stored facts)
  check(
    "mine: store-only commit detected",
    rank.isStoreOnlyChange([".claude/cairn/learnings.jsonl"]),
  );
  check(
    "mine: mixed commit still mined",
    !rank.isStoreOnlyChange([".claude/cairn/learnings.jsonl", "src/sim/core/world.ts"]),
  );
  check("mine: empty change list is not store-only", !rank.isStoreOnlyChange([]));

  // 8. install self-heal: isolated runs skip it; chaining is real + idempotent
  const inst = await import("./install.mjs");
  check("install: selfHeal no-ops under CAIRN_DIR", inst.selfHeal(cwd).length === 0);
  const fakeRepo = mkdtempSync(join(tmpdir(), "cairn-heal-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: fakeRepo });
    check(
      "install: post-commit chained in fresh repo",
      inst.chainPostCommit(fakeRepo) === true && inst.postCommitChained(fakeRepo),
    );
    check("install: chaining is idempotent", inst.chainPostCommit(fakeRepo) === false);
  } finally {
    rmSync(fakeRepo, { recursive: true, force: true });
  }

  // 9. land: a worktree's changes reach main by a three-way merge, all or nothing (lib/land.mjs)
  const { land } = await import("./land.mjs");
  const landRepo = mkdtempSync(join(tmpdir(), "cairn-land-repo-"));
  const landWt = mkdtempSync(join(tmpdir(), "cairn-land-wt-"));
  rmSync(landWt, { recursive: true, force: true });
  try {
    const g = (dir, ...a) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...a], {
        cwd: dir,
        encoding: "utf8",
      });
    const lines = (tag) => Array.from({ length: 12 }, (_, i) => `${tag} line ${i + 1}`).join("\n") + "\n";
    const edit = (path, i, text) => {
      const ls = readFileSync(path, "utf8").split("\n");
      ls[i] = text;
      writeFileSync(path, ls.join("\n"));
    };
    g(landRepo, "init", "-q");
    g(landRepo, "config", "core.autocrlf", "false");
    for (const f of ["a", "b", "c", "d", "e"]) writeFileSync(join(landRepo, `${f}.txt`), lines(f));
    g(landRepo, "add", ".");
    g(landRepo, "commit", "-qm", "base");
    g(landRepo, "worktree", "add", "-q", "--detach", landWt);
    // Main moves on after the worker's base: a commit on a.txt, an uncommitted edit on b.txt, c.txt's first line.
    edit(join(landRepo, "a.txt"), 0, "a main");
    g(landRepo, "commit", "-qam", "main moves");
    edit(join(landRepo, "b.txt"), 0, "b someone else's uncommitted edit");
    edit(join(landRepo, "c.txt"), 0, "c main");
    // The worker edits other lines of a and b, the same line of c, adds n.txt and deletes nothing yet.
    edit(join(landWt, "a.txt"), 9, "a worker");
    edit(join(landWt, "b.txt"), 9, "b worker");
    edit(join(landWt, "c.txt"), 0, "c worker");
    writeFileSync(join(landWt, "n.txt"), "new\n");

    const before = readFileSync(join(landRepo, "a.txt"), "utf8");
    const all = land(landRepo, landWt, {});
    check("land: a conflict refuses the whole landing", !all.ok && all.refused.some((r) => r.path === "c.txt"));
    check("land: nothing written on refusal", readFileSync(join(landRepo, "a.txt"), "utf8") === before);
    check("land: refusal names the conflicting block", all.text.includes("c main") && all.text.includes("c worker"));

    const dry = land(landRepo, landWt, { files: ["a.txt", "b.txt", "n.txt"], dryRun: true });
    check("land: dry run writes nothing", dry.ok && !existsSync(join(landRepo, "n.txt")));

    const ok = land(landRepo, landWt, { files: ["a.txt", "b.txt", "n.txt"] });
    const a = readFileSync(join(landRepo, "a.txt"), "utf8");
    check("land: both sides kept in a merged file", ok.ok && a.includes("a main") && a.includes("a worker"), ok.text);
    const b = readFileSync(join(landRepo, "b.txt"), "utf8");
    check("land: another session's uncommitted edit kept", b.includes("someone else's") && b.includes("b worker"));
    check("land: uncommitted edits flagged before commit", /b\.txt:.*uncommitted edits/.test(ok.text));
    check("land: new file copied", readFileSync(join(landRepo, "n.txt"), "utf8") === "new\n");
    check("land: never stages", g(landRepo, "diff", "--cached", "--name-only").trim() === "");

    rmSync(join(landWt, "d.txt"));
    const del = land(landRepo, landWt, { files: ["d.txt"] });
    check("land: a deletion is refused", !del.ok && existsSync(join(landRepo, "d.txt")));
    check("land: refuses to land onto a worktree", !land(landWt, landRepo, {}).ok);
  } catch (err) {
    check("land: scratch repo runs", false, String(err?.message || err));
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", landWt], { cwd: landRepo, stdio: "ignore" });
    } catch {}
    rmSync(landWt, { recursive: true, force: true });
    rmSync(landRepo, { recursive: true, force: true });
  }

  // 9a. git worktree remove is refused while the worktree's node_modules is a junction (it would delete main's packages)
  {
    const { symlinkSync } = await import("node:fs");
    const wtDir = mkdtempSync(join(tmpdir(), "cairn-wt-"));
    const realMods = mkdtempSync(join(tmpdir(), "cairn-mods-"));
    const bash = (session, command) =>
      runHook("pre_tool_use.mjs", { session_id: session, cwd, tool_name: "Bash", tool_input: { command } }, env).stdout;
    try {
      symlinkSync(realMods, join(wtDir, "node_modules"), "junction");
      check("worktree: removing a worktree with a node_modules junction is refused", bash("st-wt", `git worktree remove --force "${wtDir}"`).includes("junction"));
      check("worktree: a mention in quotes or an unrelated git command passes", bash("st-wt", `echo "git worktree remove ${wtDir}"`) === "" && bash("st-wt", "git worktree list") === "");
      rmSync(join(wtDir, "node_modules"), { recursive: false, force: true });
      check("worktree: once the junction is gone, the removal goes through", bash("st-wt", `git worktree remove --force "${wtDir}"`) === "");
      check(
        "worktree: a path Cairn can't read is held once, then goes through",
        bash("st-wt2", "git worktree remove $wt").includes("held this command once") && bash("st-wt2", "git worktree remove $wt") === "",
      );
    } catch (err) {
      check("worktree: junction test runs", false, String(err?.message || err));
    } finally {
      rmSync(wtDir, { recursive: true, force: true });
      rmSync(realMods, { recursive: true, force: true });
    }
  }

  // 9b. the queue's watchdog: a run whose log went silent is recorded hung, its process ended, its starter told
  {
    const TQ = await import("./testq.mjs");
    const { spawn } = await import("node:child_process");
    const { utimesSync } = await import("node:fs");
    const qdir = mkdtempSync(join(tmpdir(), "cairn-hung-"));
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    const log = join(qdir, "run-1.log");
    writeFileSync(log, "ok   something\n");
    const old = new Date(Date.now() - 30 * 60000);
    utimesSync(log, old, old);
    writeFileSync(join(qdir, "run-1.json"), JSON.stringify({ name: "simtest", key: "simtest", startedAt: old.getTime(), by: "HungStarter", log, pid: sleeper.pid, beat: Date.now() }));
    const reaped = TQ.reapHung(cwd, qdir);
    await new Promise((r) => setTimeout(r, 800));
    let gone = false;
    try {
      process.kill(sleeper.pid, 0);
    } catch {
      gone = true;
    }
    const rec = JSON.parse(readFileSync(join(qdir, "run-1.json"), "utf8"));
    check(
      "testq: a run silent for 20 min is recorded hung, its process stopped, its starter told",
      reaped.length === 1 && rec.exit === 124 && rec.hung === true && gone &&
        J.readNotices(cwd).some((n) => n.to === "HungStarter" && n.text.includes("Cairn stopped")),
    );
    check("testq: a run still writing is left alone", TQ.reapHung(cwd, qdir).length === 0);
    // A runner that died leaves a stale beat: the run is lost (the queue moves on) and its reused pid is never touched.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: "ignore" });
    other.unref();
    const stale = { name: "simtest", key: "simtest", startedAt: old.getTime(), by: "Gone", log, pid: other.pid, beat: Date.now() - 10 * 60000 };
    writeFileSync(join(qdir, "run-2.json"), JSON.stringify(stale));
    let otherAlive = false;
    TQ.reapHung(cwd, qdir);
    try {
      process.kill(other.pid, 0);
      otherAlive = true;
    } catch {}
    check("testq: a stale heartbeat means the run is gone, and a reused process number is never stopped", TQ.stateOf(stale) === "lost" && otherAlive);
    try {
      process.kill(other.pid);
    } catch {}
    rmSync(qdir, { recursive: true, force: true });
  }

  // 10. decide: a decision row commits alone, past another session's uncommitted row and a staged file
  const { decide } = await import("./decide.mjs");
  const dRepo = mkdtempSync(join(tmpdir(), "cairn-decide-repo-"));
  try {
    const g = (...a) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...a], { cwd: dRepo, encoding: "utf8" });
    g("init", "-q");
    g("config", "user.name", "t");
    g("config", "user.email", "t@t");
    mkdirSync(join(dRepo, "docs"));
    writeFileSync(join(dRepo, "docs", "DECISIONS.md"), "| Decision | Where |\n|---|---|\n| Robin: old one | x |\n");
    writeFileSync(join(dRepo, "other.txt"), "a\n");
    g("add", ".");
    g("commit", "-qm", "base");
    // Another session's row, uncommitted; another session's staged file.
    writeFileSync(join(dRepo, "docs", "DECISIONS.md"), "| Decision | Where |\n|---|---|\n| Robin: old one | x |\n| Robin: theirs | y |\n");
    writeFileSync(join(dRepo, "other.txt"), "b\n");
    g("add", "other.txt");
    const r = decide(dRepo, "| Robin: **mine** | z |", { message: "Log Robin: mine" });
    const committed = g("show", "HEAD:docs/DECISIONS.md");
    const work = readFileSync(join(dRepo, "docs", "DECISIONS.md"), "utf8");
    check(
      "decide: only my row is committed; their row and the staged file stay as they were",
      r.ok && committed.includes("mine") && !committed.includes("theirs") && !g("show", "--name-only", "--format=", "HEAD").includes("other.txt") &&
        work.includes("theirs") && work.trim().endsWith("| Robin: **mine** | z |") && g("diff", "--cached", "--name-only").trim() === "other.txt",
      r.text,
    );
    check("decide: a non-row is refused", !decide(dRepo, "just text").ok);
  } catch (err) {
    check("decide: scratch repo runs", false, String(err?.message || err));
  } finally {
    rmSync(dRepo, { recursive: true, force: true });
  }

  // hygiene: nothing leaked outside the isolated store
  check(
    "isolation: store stayed in temp dir",
    readFileSync(join(dir, "checkpoints.jsonl"), "utf8").length > 0,
  );

  rmSync(dir, { recursive: true, force: true });
  console.log(fails === 0 ? "cairn selftest: PASS" : `cairn selftest: ${fails} failure(s)`);
  return fails === 0 ? 0 : 1;
}
