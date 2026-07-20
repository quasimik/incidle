// Story→incident pipeline orchestrator — the deterministic state machine
// described in README.md. Two model roles (one writer conversation, K fresh
// players); everything else — validation, adjudication, scoring, the revision
// trigger, the iteration cap — is plain code, so the measurement instrument
// stays fixed and submitted stories are only ever string-templated into
// prompts.
//
// Run:  set -a && source .env.local && set +a && node pipeline/run.mjs job.json
// Env:  DATABASE_URL (catalog), ANTHROPIC_API_KEY or an `ant auth login` profile.
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WRITER_MODEL = "claude-opus-4-8";
const PLAYER_MODEL = "claude-sonnet-5"; // fixed: difficulty scores are only comparable on one player model
const HOURS = 7;
const LENGTH_RANGES = { topology: [20, 40], vignette: [10, 40], clue: [15, 60], postmortem: [40, 125] };

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const jobPath = args.find((a) => !a.startsWith("--"));
if (!jobPath) {
  console.error("usage: node pipeline/run.mjs job.json [--runs 3] [--max-revisions 2] [--out pipeline/out]");
  process.exit(1);
}
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const RUNS = Number(flag("runs", 3));
const MAX_REVISIONS = Number(flag("max-revisions", 2));
const OUT_ROOT = resolve(flag("out", join(here, "out")));

const job = JSON.parse(readFileSync(jobPath, "utf8"));
const source = job.sourceText ?? readFileSync(job.sourceFile, "utf8");

const client = new Anthropic();
const sql = neon(process.env.DATABASE_URL);
const catalogRows = await sql`SELECT id, name, aliases, tags FROM root_causes ORDER BY id`;
const catalog = catalogRows
  .map((r) => `${r.id} | ${r.name} | aka: ${(r.aliases ?? []).join(", ")} | tags: ${(r.tags ?? []).join(", ")}`)
  .join("\n");
const knownIds = new Set(catalogRows.map((r) => r.id));

const wordCount = (s) => s.trim().split(/\s+/).length;

// Model replies carry the payload in a ```json fence; take the first one.
function extractJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new Error("no ```json block in reply");
  return JSON.parse(m[1]);
}

async function say(messages, { model, maxTokens }) {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    messages,
  });
  if (response.stop_reason === "refusal") throw new Error("model refused the request");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  messages.push({ role: "assistant", content: response.content });
  return text;
}

// One conversational turn that must yield parseable JSON; one retry with the
// parse error appended, then give up.
async function sayJson(messages, opts) {
  const text = await say(messages, opts);
  try {
    return { json: extractJson(text), text };
  } catch (err) {
    messages.push({
      role: "user",
      content: `Your reply could not be parsed (${err.message}). Reply again with exactly the required format.`,
    });
    const retry = await say(messages, opts);
    return { json: extractJson(retry), text: retry };
  }
}

// --- Writer ---------------------------------------------------------------

const writerMessages = [
  {
    role: "user",
    content: [
      "You are the WRITER in Incidle's story→incident pipeline. Follow the base contract, then the addendum.",
      "=== AUTHORING.md (base contract) ===",
      readFileSync(join(here, "..", "AUTHORING.md"), "utf8"),
      "=== pipeline/WRITER.md (addendum) ===",
      readFileSync(join(here, "WRITER.md"), "utf8"),
      "=== Root-cause catalog (complete, 81 rows: id | name | aka | tags) ===",
      catalog,
      "=== Input package ===",
      `attribution: ${job.attribution ? JSON.stringify(job.attribution) : "none (house incident — no author field)"}`,
      `public: ${job.public ? "true" : "false (no inspiration field)"}`,
      job.inspiration ? `inspiration (verbatim if used): ${JSON.stringify(job.inspiration)}` : "",
      "=== Source story ===",
      source,
      "=== Output format ===",
      "Reply with (1) the incident JSON object in a ```json fence — fields per AUTHORING.md, no id/num/sev; author/inspiration only per the rules above — then (2) the worksheet per WRITER.md, as markdown.",
    ].join("\n\n"),
  },
];

function validate(inc) {
  const errors = [];
  const warnings = [];
  for (const id of [...(inc.answerIds ?? []), ...(inc.nearIds ?? [])]) {
    if (!knownIds.has(id)) errors.push(`unknown root cause id "${id}"`);
  }
  if (!inc.answerIds?.length) errors.push("empty answerIds");
  if (!Array.isArray(inc.clues) || inc.clues.length !== 4) warnings.push(`clues.length = ${inc.clues?.length} (convention is 4)`);
  const check = (label, text, [lo, hi]) => {
    const n = wordCount(text);
    if (n < lo || n > hi) warnings.push(`${label} is ${n} words (range ${lo}–${hi})`);
  };
  check("topology", inc.topology, LENGTH_RANGES.topology);
  check("vignette", inc.vignette, LENGTH_RANGES.vignette);
  (inc.clues ?? []).forEach((c, i) => check(`clue ${i + 1}`, c, LENGTH_RANGES.clue));
  check("postmortem", inc.postmortem, LENGTH_RANGES.postmortem);
  return { errors, warnings };
}

// --- Player ---------------------------------------------------------------

const playerPreamble = (incident) =>
  [
    "You are playtesting an Incidle incident — a root-cause guessing game. You get exactly what a real player gets, in game order, and nothing else.",
    `**Rules.** The incident's *topology* (the system before it broke) and *vignette* (the incident as first reported) are free. You have a budget of **${HOURS} hours**. One action per turn:`,
    `- \`reveal\` — reveal the next clue (there are ${incident.clues.length}, revealed in order). Costs 1 hour.`,
    '- `guess` — name a root cause by its catalog id. A correct guess wins. A wrong or near guess costs 1 hour ("near" means directionally right, but not the best answer — treat it as a hint). You may guess the same id only once.',
    `When ${HOURS} hours are spent, the incident escalates and you lose. Play to win with as few hours burned as you can — but a wrong guess costs the same as a clue, so guess when your confidence beats the value of another clue.`,
    "**Each turn, reply with exactly this JSON and nothing else:**",
    '```json\n{\n  "top3": ["<id>", "<id>", "<id>"],\n  "confidence": <0-100, that top3[0] is correct>,\n  "why": "<one sentence>",\n  "action": { "type": "reveal" } | { "type": "guess", "id": "<id>" }\n}\n```',
    "`top3` is your current best ranking whether or not you guess — it is recorded for calibration and does not cost anything or affect the game.",
    "**Guessing catalog** (complete, fixed — your guess must be one of these ids):",
    catalog,
    `**Topology:** ${incident.topology}`,
    `**Vignette:** ${incident.vignette}`,
    `T+0. ${HOURS} hours left, ${incident.clues.length} clues unrevealed. Your move.`,
  ].join("\n\n");

async function playOnce(incident) {
  const messages = [{ role: "user", content: playerPreamble(incident) }];
  const turns = [];
  let hours = 0;
  let clueIdx = 0;
  const guessed = new Set();

  while (hours < HOURS) {
    const { json: turn } = await sayJson(messages, { model: PLAYER_MODEL, maxTokens: 2000 });
    turns.push({ ...turn, hoursBefore: hours, cluesRevealed: clueIdx });

    let feedback;
    if (turn.action?.type === "reveal" && clueIdx < incident.clues.length) {
      hours += 1;
      feedback = `Clue ${clueIdx + 1}: "${incident.clues[clueIdx]}"`;
      clueIdx += 1;
    } else if (turn.action?.type === "guess") {
      const id = turn.action.id;
      if (!knownIds.has(id) || guessed.has(id)) {
        feedback = `Invalid guess ("${id}" is ${guessed.has(id) ? "already guessed" : "not a catalog id"}). No hour charged. Choose again.`;
        messages.push({ role: "user", content: feedback });
        continue;
      }
      guessed.add(id);
      if (incident.answerIds.includes(id)) {
        return { solved: true, hours, turns, squares: turns.map(squareFor(incident)).join("") };
      }
      hours += 1;
      feedback = (incident.nearIds ?? []).includes(id)
        ? `"${id}" — directionally right, but not the best answer.`
        : `"${id}" — wrong.`;
    } else {
      feedback = "Invalid action. Choose again.";
      messages.push({ role: "user", content: feedback });
      continue;
    }
    if (hours >= HOURS) break;
    messages.push({
      role: "user",
      content: `${feedback}\n\nT+${hours}. ${HOURS - hours} hours left, ${incident.clues.length - clueIdx} clues unrevealed. Your move.`,
    });
  }
  return { solved: false, hours, turns, squares: turns.map(squareFor(incident)).join("") };
}

const squareFor = (incident) => (turn) => {
  if (turn.action?.type === "reveal") return "🟦";
  if (incident.answerIds.includes(turn.action?.id)) return "🟩";
  if ((incident.nearIds ?? []).includes(turn.action?.id)) return "🟧";
  return "🟥";
};

// --- Scoring & diagnosis --------------------------------------------------

function scoreRuns(incident, runs) {
  const runScores = runs.map((r) => (r.solved ? r.hours : HOURS));
  const difficulty = runScores.reduce((a, b) => a + b, 0) / runs.length;
  const leakRuns = runs.filter((r) => {
    const preClue = r.turns.find((t) => t.cluesRevealed === 0);
    return preClue && incident.answerIds.includes(preClue.top3?.[0]);
  });
  return { runScores, difficulty, leak: leakRuns.length > 0, leakCount: leakRuns.length };
}

function diagnosis(incident, runs, score) {
  const lines = runs.map((r, i) => {
    const curve = r.turns
      .map((t) => `after ${t.cluesRevealed} clue(s): top3=[${(t.top3 ?? []).join(", ")}] conf=${t.confidence}`)
      .join("; ");
    return `Run ${i + 1} (${r.solved ? `solved at T+${r.hours}` : "DNF"}, ${r.squares}): ${curve}`;
  });
  return [
    "PLAYTEST DIAGNOSIS — your draft needs revision.",
    score.leak
      ? `Leak: ${score.leakCount}/${runs.length} fresh cold players ranked an accepted answer #1 from topology + vignette alone, before any clue.`
      : `Difficulty ${score.difficulty.toFixed(1)}/${HOURS} is out of band.`,
    ...lines,
    "Per WRITER.md → Revision requests: make the smallest edits that fix the measured problem. Reply in the same format — full incident JSON in a ```json fence, then the updated worksheet.",
  ].join("\n\n");
}

// --- Main loop ------------------------------------------------------------

console.log(`writer: ${WRITER_MODEL} → drafting…`);
let { json: incident, text: writerReply } = await sayJson(writerMessages, { model: WRITER_MODEL, maxTokens: 16000 });

let result;
for (let cycle = 0; ; cycle++) {
  const { errors, warnings } = validate(incident);
  if (errors.length) {
    if (cycle >= MAX_REVISIONS) throw new Error(`validation failed after ${cycle} revisions: ${errors.join("; ")}`);
    console.log(`validation errors → back to writer: ${errors.join("; ")}`);
    writerMessages.push({
      role: "user",
      content: `Validation failed: ${errors.join("; ")}. Fix and reply in the same format.`,
    });
    ({ json: incident, text: writerReply } = await sayJson(writerMessages, { model: WRITER_MODEL, maxTokens: 16000 }));
    continue;
  }
  warnings.forEach((w) => console.log(`warn: ${w}`));

  console.log(`playtest cycle ${cycle}: ${RUNS} × ${PLAYER_MODEL} (fresh, parallel)…`);
  const runs = await Promise.all(Array.from({ length: RUNS }, () => playOnce(incident)));
  const score = scoreRuns(incident, runs);
  console.log(`difficulty ${score.difficulty.toFixed(1)}/${HOURS} [${score.runScores.join(", ")}], leak: ${score.leak ? `YES (${score.leakCount}/${RUNS})` : "no"}`);

  result = { incident, writerReply, runs, score, cycle, warnings };
  if (!score.leak) break; // difficulty band is advisory for now; leak is the hard gate
  if (cycle >= MAX_REVISIONS) {
    console.log("revision cap reached — flagging for human review");
    result.flagged = true;
    break;
  }
  console.log("leak flagged → revision request to writer");
  writerMessages.push({ role: "user", content: diagnosis(incident, runs, score) });
  ({ json: incident, text: writerReply } = await sayJson(writerMessages, { model: WRITER_MODEL, maxTokens: 16000 }));
}

// --- Report ---------------------------------------------------------------

const slug = (result.incident.answerIds[0] + "-" + Date.now().toString(36)).replace(/[^a-z0-9-]/g, "");
const outDir = join(OUT_ROOT, slug);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "incident.json"), JSON.stringify(result.incident, null, 2) + "\n");
writeFileSync(join(outDir, "worksheet.md"), result.writerReply.replace(/```json[\s\S]*?```/, "").trim() + "\n");
writeFileSync(join(outDir, "runs.json"), JSON.stringify({ score: result.score, runs: result.runs }, null, 2) + "\n");
writeFileSync(
  join(outDir, "report.md"),
  [
    `# Pipeline report — ${result.incident.answerIds.join(", ")}`,
    `- difficulty: **${result.score.difficulty.toFixed(1)}/${HOURS}** over ${RUNS} runs [${result.score.runScores.join(", ")}]`,
    `- leak: ${result.score.leak ? `**YES** (${result.score.leakCount}/${RUNS} pre-clue top-1 hits)` : "no"}`,
    `- revision cycles: ${result.cycle}${result.flagged ? " — **cap reached, needs human review**" : ""}`,
    ...result.warnings.map((w) => `- warning: ${w}`),
    "",
    ...result.runs.map((r, i) => `Run ${i + 1}: ${r.squares} ${r.solved ? `solved at T+${r.hours}` : "DNF"}`),
    "",
    "Next: human review, then append to incidents.json (no id/num) and seed to staging.",
  ].join("\n") + "\n",
);
console.log(`report: ${join(outDir, "report.md")}`);
