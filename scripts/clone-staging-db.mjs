// One-off: clone the production database into incidle_staging on the same
// Neon instance, then schedule all incidents there as dailies #1..#N (order
// from incidents.json). Run: set -a && source .env.local && set +a && node ...
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

const src = process.env.DATABASE_URL_UNPOOLED;
if (!src) throw new Error("source .env.local first");
const admin = neon(src);
// swap only the database path segment — the username also contains "neondb"
const stg = neon(src.replace(/\/neondb(\?|$)/, "/incidle_staging$1"));

const exists = await admin`SELECT 1 FROM pg_database WHERE datname = 'incidle_staging'`;
let needCopy = false;
if (exists.length) {
  console.log("incidle_staging already exists — reusing (copy is idempotent)");
  needCopy = true;
} else {
  try {
    await admin.query("CREATE DATABASE incidle_staging TEMPLATE neondb");
    console.log("cloned via CREATE DATABASE ... TEMPLATE");
  } catch (e) {
    console.log(`TEMPLATE clone unavailable (${e.message.split("\n")[0]}) — copying manually`);
    await admin.query("CREATE DATABASE incidle_staging");
    needCopy = true;
  }
}

if (needCopy) {
  const tables = await admin`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  // root_causes first: incidents references it
  const names = tables.map((t) => t.table_name).sort((a) => (a === "root_causes" ? -1 : 1));
  for (const name of names) {
    const cols = await admin`
      SELECT column_name, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${name}
      ORDER BY ordinal_position`;
    const pk = await admin`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${name}::regclass AND i.indisprimary`;
    const ddl = `CREATE TABLE IF NOT EXISTS "${name}" (${cols
      .map((c) => `"${c.column_name}" ${c.udt_name}${c.is_nullable === "NO" ? " NOT NULL" : ""}`)
      .join(", ")}${pk.length ? `, PRIMARY KEY (${pk.map((r) => `"${r.attname}"`).join(", ")})` : ""})`;
    await stg.query(ddl);
    const rows = await admin.query(`SELECT * FROM "${name}"`);
    const colNames = cols.map((c) => `"${c.column_name}"`).join(", ");
    const ph = cols
      .map((c, i) => `$${i + 1}${c.udt_name === "jsonb" ? "::jsonb" : ""}`)
      .join(", ");
    for (const row of rows) {
      const vals = cols.map((c) => {
        const v = row[c.column_name];
        // json(b) goes as text through the ::jsonb cast; PG arrays (_text
        // etc.) pass through raw — the driver serializes JS arrays natively
        if (v !== null && (c.udt_name === "jsonb" || c.udt_name === "json"))
          return JSON.stringify(v);
        return v;
      });
      await stg.query(`INSERT INTO "${name}" (${colNames}) VALUES (${ph}) ON CONFLICT DO NOTHING`, vals);
    }
    console.log(`${name}: ${rows.length} rows copied`);
  }
}

// schedule every incident as a daily, numbered by incidents.json order
const data = JSON.parse(readFileSync(new URL("../incidents.json", import.meta.url), "utf8"));
let n = 0;
for (const inc of data.incidents) {
  await stg.query("UPDATE incidents SET num = $1 WHERE id = $2", [++n, inc.id]);
}
const check = await stg`SELECT num, id, answer_id FROM incidents ORDER BY num`;
for (const r of check) console.log(`#${String(r.num).padEnd(3)} ${r.id}  ${r.answer_id}`);
console.log("staging database ready");
