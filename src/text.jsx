// wrap matched ranges in <mark>
export function highlight(text, ranges) {
  if (!ranges || ranges.length === 0) return text;
  const out = [];
  let pos = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i] > pos) out.push(text.slice(pos, ranges[i]));
    out.push(<mark key={i}>{text.slice(ranges[i], ranges[i + 1])}</mark>);
    pos = ranges[i + 1];
  }
  out.push(text.slice(pos));
  return out;
}

// `code` spans in feed text — odd-index segments sit inside backticks.
export function rich(text) {
  return text.split("`").map((seg, i) => (i % 2 ? <code key={i}>{seg}</code> : seg));
}
