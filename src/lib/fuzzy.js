// Pure fuzzy-filter helpers — no signals, no BPF.
import { sigName } from "./signals.js";

// Subsequence match: every char of `q` appears in `text`, in order,
// case-insensitive. Empty query matches everything. This is the classic
// fuzzy-finder test ("ngtrm" matches "nginx … SIGTERM").
export const fuzzyMatch = (q, text) => {
  if (!q) return true;
  const query = q.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < query.length; j++) {
    if (t[j] === query[i]) i++;
  }
  return i === query.length;
};

// The searchable fields of a feed row, in the order they're matched: both
// endpoints (comm + pid), the signal name, the source, and the disposition —
// so you can filter by process, by pid, by signal ("term" → SIGTERM), by how it
// was raised, or by whether it was caught. `haystack` and `fieldHits` both walk
// this, so the match test and the highlighter can never drift apart.
export const rowFields = (r) => [
  ["sComm", r.sComm || ""],
  ["sPid", `${r.sPid}`],
  ["sig", sigName(r.sig)],
  ["tComm", r.tComm || ""],
  ["tPid", `${r.tPid}`],
  ["src", r.src || ""],
  ["disp", r.disp || ""],
];

export const haystack = (r) => rowFields(r).map(([, t]) => t).join(" ");

// Greedy subsequence match over the fields joined by single spaces (exactly
// like `haystack`), recording which local indices of each field the query
// consumed — so the feed can highlight the matched characters in place. Returns
// a `{ fieldKey: Set<index> }` map, or null if the row doesn't match.
export const fieldHits = (q, r) => {
  if (!q) return null;
  const query = q.toLowerCase();
  const fields = rowFields(r);
  const hits = {};
  let qi = 0;
  for (let f = 0; f < fields.length && qi < query.length; f++) {
    const [key, text] = fields[f];
    const t = text.toLowerCase();
    for (let j = 0; j < t.length && qi < query.length; j++) {
      if (t[j] === query[qi]) {
        if (!hits[key]) hits[key] = new Set();
        hits[key].add(j);
        qi++;
      }
    }
    // the single space that joins this field to the next
    if (f < fields.length - 1 && qi < query.length && query[qi] === " ") qi++;
  }
  return qi === query.length ? hits : null;
};
