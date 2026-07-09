import uFuzzy from "@leeoniya/ufuzzy";

// ---------------------------------------------------------------------------
// ANSWER LIST — fixed taxonomy of root causes, fetched at runtime from
// /api/root-causes (Neon Postgres; same shape the old JSON file had).
// Guesses are selected from this list (autocomplete), so alias-matching
// problems never occur. Each entry: id, name, aliases, description, tags
// (sorted important-first; tags[0] is the primary group, and an `external`
// first tag marks causes outside the team's control), plus four diagnostic
// axes (detection_signal, onset_shape, correlation, blast_radius) that are
// deliberately not wired into gameplay yet.
// ---------------------------------------------------------------------------
// Fuzzy matching via uFuzzy: single-error typo tolerance within terms,
// out-of-order terms. Haystack rows are each answer's name, each alias, and
// each tag, all mapped back to the answer; best-ranked row wins per answer.
// Indexing tags makes a whole category queryable at once — e.g. "external"
// surfaces every external cause (vendor outage, cloud provider outage, …).
const uf = new uFuzzy({ intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1 });

// Only the first MAX_SUGGESTIONS matches are shown; any beyond that collapse
// into a "-- N more --" hint. The list stays short — narrow the query to
// surface the rest.
const MAX_SUGGESTIONS = 6;

export function buildMatcher(answers) {
  const answerById = Object.fromEntries(answers.map((a) => [a.id, a]));
  const hay = [];
  const hayAns = []; // parallel to hay: { a, hit, kind } — hit null on name rows
  for (const a of answers) {
    hay.push(a.name);
    hayAns.push({ a, hit: null, kind: "name" });
    for (const al of a.aliases) {
      hay.push(al);
      hayAns.push({ a, hit: al, kind: "alias" });
    }
    for (const t of a.tags) {
      hay.push(t);
      hayAns.push({ a, hit: t, kind: "tag" });
    }
  }

  // Returns { items, more }: items is up to MAX_SUGGESTIONS matches, each
  // { a, hit, kind, ranges } — kind is "name" | "alias" | "tag", ranges are
  // [from,to) pairs into the matched string (name / alias / tag); more is the
  // count of further distinct matches, shown only as a "-- N more --" hint.
  // Two tiers so tags stay lower-priority: name/alias rows fill slots first
  // (in uFuzzy's rank order), then tag rows take any that remain. A tag hit
  // thus never displaces a name/alias match, and only appears when there's
  // room — and answers that match both surface via their name/alias.
  function matchAnswers(q) {
    const s = q.trim();
    if (!s) return { items: [], more: 0 };
    const [idxs, info, order] = uf.search(hay, s, 3);
    if (!idxs || idxs.length === 0) return { items: [], more: 0 };
    const ordered = order ?? idxs.map((_, i) => i);
    const all = [];
    const seen = new Set();
    for (const tier of [["name", "alias"], ["tag"]]) {
      for (const oi of ordered) {
        const hi = info ? info.idx[oi] : idxs[oi];
        const { a, hit, kind } = hayAns[hi];
        if (!tier.includes(kind) || seen.has(a.id)) continue;
        seen.add(a.id);
        all.push({ a, hit, kind, ranges: info ? info.ranges[oi] : null });
      }
    }
    return { items: all.slice(0, MAX_SUGGESTIONS), more: Math.max(0, all.length - MAX_SUGGESTIONS) };
  }

  return { answerById, matchAnswers };
}
