// Pure render helpers: padding, truncation, and a compact "how long ago"
// formatter. No Intl (the runtime lacks it) — everything is hand-rolled.

export const ljust = (s, n) => {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
};

export const rjust = (s, n) => {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
};

// Truncate to n columns with a trailing ellipsis when it doesn't fit.
export const clip = (s, n) => {
  s = String(s);
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
};

// Seconds → "now" / "420ms" / "3.4s" / "12s" / "2m03". Coarsens as it grows so
// each reading stays short enough for a fixed gutter.
export function ago(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  if (sec < 0.05) return "now";
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  return `${m}m${String(Math.round(sec - m * 60)).padStart(2, "0")}`;
}

// A nanosecond duration as ns / µs / ms / s — for handler run times.
export function dur(ns) {
  if (ns == null) return "";
  if (ns < 1e3) return `${Math.round(ns)}ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(ns < 1e4 ? 1 : 0)}µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(ns < 1e7 ? 1 : 0)}ms`;
  return `${(ns / 1e9).toFixed(1)}s`;
}

// Compact integer counts for the tally bars: 1234 → "1.2k".
export function count(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
