// BPF data layer — the only BPF-aware module. It subscribes to the signal
// ring buffer, folds the stream into a rolling feed plus running tallies, and
// exposes it all as plain reactive signals; it also owns the mute-mask knob
// the UI patches into the kernel.
//
// Two directions of reactivity live here:
//   kernel → user : `feed` is built with from() over the ring buffer — the
//                   subscription's lifecycle is tied to the signal being
//                   watched. A short window timer batches events into one
//                   render per frame (a supervisor can raise thousands of
//                   signals a second) and coalesces identical repeats.
//   user → kernel : toggleMute(sig) patches the `mute_mask` global in the
//                   program's .data section, so the kernel drops (or stops
//                   dropping) that signal live — driven by the signal picker.
import { DataSec, RingBuf } from "yeet:bpf";
import { computed, from, signal } from "yeet:tui";
import { control } from "@/probes/probe.js";
import { disposition, isFatalBlow, severity, source } from "@/lib/signals.js";
import { fuzzyMatch, haystack } from "@/lib/fuzzy.js";

const FLUSH_MS = 120; // publish cadence — one re-render per frame, not per event
const MAX_ROWS = 600; // feed rows kept (coalesced)
const COALESCE_NS = 2e9; // fold identical repeats within this gap into one row

const events = new RingBuf(control, "events");
const dispatch = new RingBuf(control, "dispatch");
const knobs = new DataSec(control, "probe.data");

const CORRELATE_NS = 5e9; // how far back to match a delivery to its generation

// Comm arrives as a NUL-terminated byte array (or already a string). No
// TextDecoder in the runtime — walk the bytes.
const commStr = (c) => {
  if (typeof c === "string") return c.replace(/\0.*$/s, "");
  if (!c) return "";
  let s = "";
  for (const b of c) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
};

// --- the mute mask (user → kernel) --------------------------------------
// Bit N mutes signal N: the kernel drops it before it ever reaches the ring
// buffer, so muting costs nothing. `muteMask` mirrors the __u64 global in the
// program's .data section; the signal picker flips individual bits and patches
// the change through live (DataSec.patch) while the program keeps running. The
// default mirrors the compiled-in mask in sigwire.bpf.c — SIGCHLD (17),
// SIGURG (23), SIGWINCH (28), the three signals that are pure background hum on
// any busy box — but every signal is now the user's to mute or show.
const bit = (n) => 1n << BigInt(n);
const DEFAULT_MUTE = bit(17) | bit(23) | bit(28);

export const muteMask = signal(DEFAULT_MUTE); // matches the kernel's boot default

export const isMuted = (sig) => (muteMask.get() & bit(sig)) !== 0n;

export function toggleMute(sig) {
  const next = muteMask.get() ^ bit(sig);
  muteMask.set(next);
  knobs.patch({ mute_mask: next }); // __u64 → BigInt, re-filters live in-kernel
}

// Bulk set/clear a batch of signals at once — one patch, so "mute/show all" in
// the picker is a single kernel round-trip rather than N.
function applyMask(sigs, mute) {
  let m = muteMask.get();
  for (const s of sigs) m = mute ? m | bit(s) : m & ~bit(s);
  muteMask.set(m);
  knobs.patch({ mute_mask: m });
}
export const muteAll = (sigs) => applyMask(sigs, true);
export const showAll = (sigs) => applyMask(sigs, false);

// popcount of the live mask — how many signals are currently hidden.
export const mutedCount = computed(() => {
  let m = muteMask.get();
  let n = 0;
  while (m) {
    n += Number(m & 1n);
    m >>= 1n;
  }
  return n;
});

// --- pause (freeze the display without dropping data) -------------------
export const paused = signal(false);
let republish = null; // set while `feed` is watched, so unpause repaints now

export function togglePause() {
  paused.set(!paused.get());
  if (!paused.get() && republish) republish();
}

// --- the reactive feed (kernel → user) ----------------------------------
const empty = () => ({
  rows: [],
  total: 0,
  rate: 0,
  fatal: 0,
  bySig: {},
  bySrc: {},
  byDisp: { caught: 0, default: 0, ignored: 0 },
  eintr: 0,
  latestTs: 0,
});

export const feed = from((state) => {
  let pending = [];
  let pendingDisp = [];
  const rows = []; // newest first, coalesced
  const bySig = {};
  const bySrc = {};
  const byDisp = { caught: 0, default: 0, ignored: 0 };
  let total = 0;
  let fatal = 0;
  let eintr = 0;
  let latestTs = 0;
  let rate = 0;

  const sub = events.subscribe((w) => {
    const e = w?.signal_event ?? w;
    if (e) pending.push(e);
  });
  // The delivery side: signal_deliver (phase 0) carries disposition + flags +
  // the target's blocked mask; rt_sigreturn (phase 1) carries the handler
  // duration. Both are correlated back to a generation row below.
  const subD = dispatch.subscribe((w) => {
    const e = w?.dispatch_event ?? w;
    if (e) pendingDisp.push(e);
  });

  const publish = () => {
    state.set({
      rows: rows.slice(0, MAX_ROWS),
      total,
      rate,
      fatal,
      bySig: { ...bySig },
      bySrc: { ...bySrc },
      byDisp: { ...byDisp },
      eintr,
      latestTs,
    });
  };
  republish = publish;

  const flush = () => {
    const batch = pending;
    pending = [];

    for (const raw of batch) {
      const sig = raw.sig | 0;
      const code = raw.code | 0;
      const result = raw.result | 0;
      const ts = Number(raw.ts_ns);
      const sPid = raw.sender_pid >>> 0;
      const tPid = raw.target_pid >>> 0;
      const sev = severity(sig);
      const src = source(code);

      if (ts > latestTs) latestTs = ts;
      total += 1;
      bySig[sig] = (bySig[sig] || 0) + 1;
      bySrc[src] = (bySrc[src] || 0) + 1;
      if (isFatalBlow(sig, code, result)) fatal += 1;

      // Coalesce a run of identical signals (same source, target, signal,
      // code, disposition) into a single ×N row so a burst reads as one line.
      const head = rows[0];
      if (
        head &&
        head.sPid === sPid &&
        head.tPid === tPid &&
        head.sig === sig &&
        head.code === code &&
        head.result === result &&
        ts - head.ts < COALESCE_NS
      ) {
        head.count += 1;
        head.ts = ts;
        continue;
      }

      rows.unshift({
        id: (head?.id ?? 0) + 1 + total, // monotone-ish, only used as a React-ish key
        ts,
        count: 1,
        sPid,
        sTgid: raw.sender_tgid >>> 0,
        sComm: commStr(raw.sender_comm),
        tPid,
        tComm: commStr(raw.target_comm),
        sig,
        code,
        result,
        group: raw.group | 0,
        sev,
        src,
        // Filled in by the delivery correlation below, once seen.
        disp: null, // "caught" | "default" | "ignored"
        handler: 0n,
        saFlags: 0,
        blocked: 0n,
        durNs: null, // handler wall time, for caught signals that returned
        eintr: 0, // 0 none · 1 EINTR · 2 restarted
        intrSyscall: -1, // syscall this signal interrupted, or -1
      });
    }
    if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;

    // Correlate delivery/return events back to their generation row by
    // (target tid, signal). Best-effort: the two tracepoints share no id, so we
    // match the most recent unresolved generation within a time window. Runs
    // after the generation loop so a same-window delivery can find its row.
    const dispBatch = pendingDisp;
    pendingDisp = [];
    for (const d of dispBatch) {
      const pid = d.pid >>> 0;
      const sig = d.sig | 0;
      const ts = Number(d.ts_ns);
      const phase = d.phase | 0;
      if (ts > latestTs) latestTs = ts;
      for (const r of rows) {
        if (r.ts < ts - CORRELATE_NS) break; // rows are newest-first
        if (r.tPid !== pid || r.sig !== sig || r.ts > ts) continue;
        if (phase === 0) {
          if (r.disp) continue; // annotated already — keep looking for an older match
          r.disp = disposition(d.handler);
          r.handler = d.handler;
          r.saFlags = Number(d.sa_flags || 0);
          r.blocked = d.blocked;
          r.eintr = d.eintr | 0;
          r.intrSyscall = d.intr_syscall | 0;
          byDisp[r.disp] = (byDisp[r.disp] || 0) + 1;
          if (r.eintr === 1) eintr += 1;
          break;
        } else {
          if (r.disp !== "caught") continue;
          r.durNs = Number(d.dur_ns);
          break;
        }
      }
    }

    // Smooth the instantaneous per-window rate into a readable number.
    const inst = batch.length / (FLUSH_MS / 1000);
    rate = rate * 0.7 + inst * 0.3;

    if (!paused.get()) publish();
  };

  const h = setInterval(flush, FLUSH_MS);
  return () => {
    clearInterval(h);
    republish = null;
    sub.then((s) => s.unsubscribe());
    subD.then((s) => s.unsubscribe());
  };
}, empty());

// --- the EINTR view filter ----------------------------------------------
// A view-only filter (EINTR is decided at delivery, after generation, so it
// can't be a kernel mute). `visible` is the single filtered row list that both
// the feed and the inspector read, so a selection index means the same thing
// in both — the aggregate tallies keep reading the unfiltered `feed`.
export const eintrOnly = signal(false);
export const toggleEintr = () => eintrOnly.set(!eintrOnly.get());

// --- the fuzzy filter ----------------------------------------------------
// A view-only filter (like eintrOnly): the query is subsequence-matched
// against each row's searchable text — both endpoints (comm + pid), the signal
// name, the source, and the disposition — so "nginx" narrows to a process,
// "term" to SIGTERM, "8813" to a pid, "caught" to handled signals. It survives
// pause/resume, so you can filter to a process and then watch just its traffic
// stream live. The aggregate tallies keep reading the unfiltered `feed`.
export const filter = signal("");

export const visible = computed(() => {
  const s = feed.get();
  const q = filter.get();
  const eo = eintrOnly.get();
  let rows = s.rows;
  if (eo) rows = rows.filter((r) => r.eintr);
  if (q) rows = rows.filter((r) => fuzzyMatch(q, haystack(r)));
  return { rows, latestTs: s.latestTs };
});
