// Print the root-cause catalog in the compact form the pipeline feeds to
// writer and player subagents: one row per cause, id | name | aka | tags.
// Run:  set -a && source .env.local && set +a && node pipeline/fetch-catalog.mjs
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`SELECT id, name, aliases, tags FROM root_causes ORDER BY id`;
for (const r of rows) {
  console.log(
    `${r.id} | ${r.name} | aka: ${(r.aliases ?? []).join(", ")} | tags: ${(r.tags ?? []).join(", ")}`,
  );
}
