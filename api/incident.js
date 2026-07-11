import { neon } from "@neondatabase/serverless";

// One custom (off-calendar) incident by its ic_ id. The id is an unguessable
// capability: whoever holds the /a/<id> link can play, and nothing else lists
// these — see the exclusion note in api/incidents.js. Answer-derived fields
// stay out of this payload too; verdicts come from POST /api/guess.
export default async function handler(req, res) {
  const id = String(req.query.id ?? "");
  if (!/^ic_[a-z0-9]{8}$/.test(id)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT id, topology, vignette, clues
    FROM incidents
    WHERE id = ${id}`;
  if (rows.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).json({ incident: rows[0] });
}
