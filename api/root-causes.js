import { neon } from "@neondatabase/serverless";

// Serves the answer list from Neon in the same shape as
// incident_root_causes.json's `root_causes` array (ordered, minus `ord`).
export default async function handler(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT id, name, aliases, description, tags,
           detection_signal, onset_shape, correlation, blast_radius
    FROM root_causes
    ORDER BY ord`;
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).json({ root_causes: rows });
}
