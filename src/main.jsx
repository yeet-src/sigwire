/* sigwire — a live signal switchboard.
 *
 * Every signal the kernel generates for any task on the box, streamed to your
 * terminal as it happens: who sent it, who it's aimed at, which signal, how it
 * was raised (kill / tgkill / kernel / timer), whether the target caught it,
 * how long its handler ran, and what it was blocking. It answers the universal
 * mystery — "what killed my process?" — by just showing you. Built on the
 * signal:signal_generate + signal_deliver tracepoints, in both directions:
 *
 *   kernel → user : probes/sigwire.js builds `feed` with from() over two ring
 *                   buffers — generation (sender view) and delivery (target
 *                   view: disposition, handler duration, blocked mask) —
 *                   batched into one frame per window, identical repeats
 *                   coalesced, delivery correlated back onto generation rows.
 *   user → kernel : the `s` signal picker toggles bits in the mute mask, a
 *                   global in the running program's .data section
 *                   (DataSec.patch), so the kernel drops (or stops dropping)
 *                   each chosen signal live.
 *
 * Two view-only filters ride on top of the feed without touching the kernel:
 * `/` fuzzy-filters rows by a typed query, and `e` narrows to interrupted
 * syscalls. Both feed the shared `visible` list the panel and inspector read.
 *
 * Layout: probes/ (BPF-aware) → components/ (pure UI) → lib/ (pure helpers),
 * imported through the `@/` source alias and composed here. The feed fills the
 * body; a tally rail rides alongside — or, when you pause and pick a row, a
 * detail panel with the full per-signal breakdown.
 */
import { Box, Layer, mount, signal } from "yeet:tui";
import { eintrOnly, feed, filter, isMuted, muteAll, paused, showAll, toggleEintr, toggleMute, togglePause, visible } from "@/probes/sigwire.js";
import TitleBar from "@/components/titlebar.jsx";
import Feed from "@/components/feed.jsx";
import Tally from "@/components/tally.jsx";
import Detail from "@/components/detail.jsx";
import Footer from "@/components/footer.jsx";
import Picker, { PICK_SIGNALS } from "@/components/picker.jsx";

const RAIL_W = 30; // tally / detail rail width
const RAIL_MIN_COLS = 96; // hide the rail below this terminal width
const PICK_W = 46; // signal-picker modal width

// The signal picker is a modal: while it's open it captures navigation, and a
// scrim + floating panel float over the feed.
const pickerOpen = signal(false);
const pickCursor = signal(0);
const moveCursor = (d) => pickCursor.set(Math.max(0, Math.min(PICK_SIGNALS.length - 1, pickCursor.get() + d)));

// Type a signal number to jump the cursor straight to it — digits accumulate
// (so "1" then "5" lands on 15) and reset once they'd overflow the list or on
// any non-digit key. Faster than arrowing through 31 rows.
let numBuf = "";
const jumpToNumber = (d) => {
  numBuf += d;
  let n = parseInt(numBuf, 10);
  if (n > PICK_SIGNALS.length) { numBuf = d; n = parseInt(d, 10); } // overflow → start over from this digit
  if (n >= 1) pickCursor.set(n - 1); // signal N ⇒ row N-1
};

// -1 = no selection (live). Selecting a row freezes the feed so it holds still.
const sel = signal(-1);
let visibleRows = 0; // most recent body height, for clamping selection on screen

const clampSel = (i) => {
  const len = Math.min(visibleRows, visible.get().rows.length);
  if (len <= 0) return -1;
  return Math.max(0, Math.min(len - 1, i));
};

const moveSel = (d) => {
  if (!paused.get()) {
    togglePause(); // arrow keys pause first, then select
    sel.set(clampSel(0));
    return;
  }
  sel.set(clampSel((sel.get() < 0 ? 0 : sel.get()) + d));
};

// Fuzzy filter: `/` enters filter mode, where keystrokes build the query live
// (the feed narrows as you type). A query edit changes the visible set, so drop
// any selection back to the top to keep the index meaningful.
const filtering = signal(false); // true while capturing the query
const editQuery = (next) => {
  filter.set(next);
  if (sel.get() >= 0) sel.set(clampSel(sel.get()));
};

tty.on("keydown", (e) => {
  const key = e.key ?? "";
  const k = key.toLowerCase();

  // While the picker is open it owns navigation: arrows move the cursor, digits
  // jump to a signal number, space/enter toggles that signal's mute, `a` toggles
  // them all, esc (or `s` again) closes. q still quits.
  if (pickerOpen.get()) {
    if (/^[0-9]$/.test(k)) return jumpToNumber(k);
    numBuf = ""; // any non-digit ends a numeric jump
    if (e.code === "Escape" || k === "s") return pickerOpen.set(false);
    if (k === "q") return yeet.exit();
    if (e.code === "ArrowUp" || k === "k") return moveCursor(-1);
    if (e.code === "ArrowDown" || k === "j") return moveCursor(1);
    if (e.code === "Space" || e.code === "Enter") return toggleMute(pickCursor.get() + 1);
    if (k === "a") {
      // If anything is still shown, mute everything; once all-muted, show all.
      return PICK_SIGNALS.some((s) => !isMuted(s)) ? muteAll(PICK_SIGNALS) : showAll(PICK_SIGNALS);
    }
    return;
  }

  // While filtering, keystrokes build the query; only the arrow keys navigate
  // (j/k are query input, not motion, so you can type "kill", "journald", …).
  if (filtering.get()) {
    if (e.code === "Escape") return (editQuery(""), filtering.set(false)); // clear + leave
    if (e.code === "Enter") return filtering.set(false); // accept: keep the filter, stop typing
    if (e.code === "Backspace") return editQuery(filter.get().slice(0, -1));
    if (e.code === "ArrowUp") return moveSel(-1);
    if (e.code === "ArrowDown") return moveSel(1);
    if (key.length === 1 && !e.ctrlKey && !e.altKey) return editQuery(filter.get() + key); // printable → append
    return;
  }

  // Esc backs out one layer at a time: filter query → selection → quit.
  if (e.code === "Escape") {
    if (filter.get()) return editQuery("");
    return sel.get() >= 0 ? sel.set(-1) : yeet.exit();
  }
  if (k === "q") return yeet.exit();
  if (k === "p" || e.code === "Space") {
    const wasPaused = paused.get();
    togglePause();
    if (wasPaused) sel.set(-1); // resuming clears the selection (the filter persists)
    return;
  }
  if (k === "s") { numBuf = ""; return pickerOpen.set(true); }
  if (k === "/") return filtering.set(true);
  if (k === "e") {
    toggleEintr();
    if (sel.get() >= 0) sel.set(clampSel(sel.get())); // keep selection in range
    return;
  }
  if (e.code === "ArrowUp" || k === "k") return moveSel(-1);
  if (e.code === "ArrowDown" || k === "j") return moveSel(1);
});

// The root receives the terminal's reactive size signal; reading it inside the
// body thunk reflows on resize. Fixed 1-row title + footer; the feed fills the
// flex body, with the rail beside it on wide terminals. The rail shows the
// detail panel while a row is selected, otherwise the aggregate tally.
const Root = (size) => (
  <Layer>
    <Box width="1fr" height="1fr">
      <TitleBar feed={feed} />
      <Box height="1fr" direction="row" overflow="hidden">
        {() => {
          const { cols, rows } = size.get();
          const body = Math.max(1, rows - 2);
          visibleRows = body - 1;
          const wide = cols >= RAIL_MIN_COLS;
          return [
            <Box width="1fr" overflow="hidden">
              <Feed view={visible} rows={body - 1} sel={sel} filtered={eintrOnly} />
            </Box>,
            wide ? (
              <Box width={`${RAIL_W}`} overflow="hidden">
                {() => (sel.get() >= 0 ? <Detail view={visible} sel={sel} /> : <Tally feed={feed} rows={body} />)}
              </Box>
            ) : null,
          ];
        }}
      </Box>
      <Footer filtering={filtering} filter={filter} visible={visible} feed={feed} />
    </Box>
    {/* dim scrim behind the modal — click it (or Esc) to dismiss */}
    {() => (pickerOpen.get() ? <Box width="1fr" height="1fr" z={10} bg="#00000088" onClick={() => pickerOpen.set(false)} /> : null)}
    {/* the floating picker panel, centred over the feed */}
    {() => {
      if (!pickerOpen.get()) return null;
      const { cols, rows } = size.get();
      const listMax = Math.min(PICK_SIGNALS.length, Math.max(3, rows - 8));
      const h = listMax + 3; // border (2) + title (1)
      const left = Math.max(0, (cols - PICK_W) >> 1);
      const top = Math.max(0, (rows - h) >> 1);
      return (
        <Box
          left={`${left}`}
          top={`${top}`}
          width={`${PICK_W}`}
          height={`${h}`}
          z={20}
          border={{ line: "round", fg: "#2f6f64" }}
          bg="#0c1512"
          padding={[0, 1]}
        >
          <Picker feed={feed} cursor={pickCursor} rows={listMax} />
        </Box>
      );
    }}
  </Layer>
);

mount(Root);
await new Promise(() => {}); // keep the script alive; the TUI owns the screen
