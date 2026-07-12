// Seed/update the incident pool in Neon from incidents.json (the untracked
// authoring copy at the repo root). Idempotent: upserts by id, and mints an
// ic_ id for any entry that lacks one, WRITING IT BACK into the JSON — an
// already-shared /a/<id> link must never change, so ids live with the entry.
//
// Entries with a "num" are dailies (day N plays num-ordered pool[N % length]);
// entries without one are customs, reachable only via their /a/<id> link and
// deliberately excluded from the /api/incidents payload.
//
// Run:  set -a && source .env.local && set +a && node scripts/seed-incidents.mjs
import { neon } from "@neondatabase/serverless";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../incidents.json", import.meta.url);

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function mintId(taken) {
  for (;;) {
    const id =
      "ic_" +
      Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");
    if (!taken.has(id)) return id;
  }
}

const data = JSON.parse(readFileSync(FILE, "utf8"));
const taken = new Set(data.incidents.map((i) => i.id).filter(Boolean));
let minted = 0;
data.incidents = data.incidents.map((inc) => {
  if (inc.id) return inc;
  minted++;
  const id = mintId(taken);
  taken.add(id);
  return { id, ...inc }; // id first, purely for readability of the JSON
});
if (minted > 0) writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");

const sql = neon(process.env.DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS incidents (
    id         text     PRIMARY KEY,
    num        smallint UNIQUE,
    sev        smallint,
    topology   text     NOT NULL,
    vignette   text     NOT NULL,
    clues      jsonb    NOT NULL,
    answer_ids jsonb    NOT NULL,
    near_ids   jsonb    NOT NULL DEFAULT '[]',
    postmortem text     NOT NULL,
    author      jsonb,
    inspiration jsonb
  )`;
// credits, shown on the postmortem. author is guest contributions only —
// { "text": "handle", "url": "https://…" } (url optional), rendered as
// "guest contribution by <handle>"; omit it for house-written incidents.
// inspiration: { "text": "the 2024 CrowdStrike outage", "url": "https://…" }
// (url optional). Both nullable — the credit line simply doesn't render.
await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS author jsonb`;
await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS inspiration jsonb`;
// sev is dead: newer entries don't carry one and nothing reads it anymore
await sql`ALTER TABLE incidents ALTER COLUMN sev DROP NOT NULL`;

// answer_ids is an accept-set in descending order of goodness: any member
// counts as the solve, and the reveal shows them all, headlining [0] as the
// best. jsonb can't carry the FK the old scalar answer_id had, so the catalog
// check happens here instead — every answer and near id must exist in
// root_causes before anything is written.
const known = new Set((await sql`SELECT id FROM root_causes`).map((r) => r.id));
for (const inc of data.incidents) {
  const answerIds = inc.answerIds ?? [inc.answerId];
  for (const rc of [...answerIds, ...(inc.nearIds ?? [])]) {
    if (!known.has(rc)) throw new Error(`${inc.id}: unknown root cause "${rc}"`);
  }
}

for (const inc of data.incidents) {
  const answerIds = inc.answerIds ?? [inc.answerId];
  await sql`
    INSERT INTO incidents (id, num, sev, topology, vignette, clues, answer_ids, near_ids, postmortem, author, inspiration)
    VALUES (${inc.id}, ${inc.num ?? null}, ${inc.sev ?? null}, ${inc.topology}, ${inc.vignette},
            ${JSON.stringify(inc.clues)}::jsonb, ${JSON.stringify(answerIds)}::jsonb,
            ${JSON.stringify(inc.nearIds ?? [])}::jsonb, ${inc.postmortem},
            ${inc.author ? JSON.stringify(inc.author) : null}::jsonb,
            ${inc.inspiration ? JSON.stringify(inc.inspiration) : null}::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      num = EXCLUDED.num, sev = EXCLUDED.sev, topology = EXCLUDED.topology,
      vignette = EXCLUDED.vignette, clues = EXCLUDED.clues,
      answer_ids = EXCLUDED.answer_ids, near_ids = EXCLUDED.near_ids,
      postmortem = EXCLUDED.postmortem, author = EXCLUDED.author,
      inspiration = EXCLUDED.inspiration`;
  const slot = inc.num != null ? `daily #${inc.num}` : `https://incidle.com/a/${inc.id}`;
  console.log(`${inc.id}  ${answerIds.join(", ").padEnd(28)} ${slot}`);
}
console.log(`\n${data.incidents.length} incidents upserted (${minted} new id${minted === 1 ? "" : "s"} minted).`);
