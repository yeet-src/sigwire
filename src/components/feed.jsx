// The switchboard: a live, newest-first feed of generated signals, one line
// each — sender ──SIG──▶ target — coloured by severity, with a right-hand
// note for the source (kill/tgkill/kernel/…), the ×N coalesce count, and a
// badge when the signal was lethal or ignored. Lethal deliveries get a faint
// row tint so a kill jumps off the screen. Pure UI: it reads the `feed`
// snapshot and nothing else.
import { Box, Text } from "yeet:tui";
import { SEV_COLOR, isFatalBlow, sigName, syscallName, wasIgnored } from "@/lib/signals.js";
import { ago, clip, dur, ljust, rjust } from "@/lib/format.js";
import { fieldHits } from "@/lib/fuzzy.js";
import { filter } from "@/probes/sigwire.js";

const BRIGHT = "#e6f0ea";
const DIM = "#5f6f68";
const FAINT = "#3a4640";
const IGN = "#9a8a4a";
const CAUGHT = "#5fe08a";
const EINTR_C = "#ff8c1a"; // the "your syscall just got cancelled" orange
const SEL = "#123f3a"; // selected-row background — a clearly-lit teal band
const SEL_BAR = "#3ddc84"; // the bright cursor bar down the selected row's edge
const GUTTER = "▌"; // left-edge marker cell (U+258C), lit only on the selection
const MATCH_BG = "#5c4a1a"; // amber marker under chars matched by the fuzzy filter

const TIME_W = 7;
const EP_W = 22; // endpoint column (comm·pid)
const WIRE_W = 15; // the wire + signal label + arrowhead

// Render `text` in the given face, but with the characters at `hits` (a Set of
// indices, or null) lit on the match-highlight background — so a fuzzy filter
// shows exactly which characters it matched. No hits → one plain span.
const hl = (text, hits, fg, bold) => {
  if (!hits || !hits.size) return <Text break="none" fg={fg} bold={bold}>{text}</Text>;
  const spans = [];
  let i = 0;
  while (i < text.length) {
    const on = hits.has(i);
    let j = i + 1;
    while (j < text.length && hits.has(j) === on) j++;
    const seg = text.slice(i, j);
    spans.push(
      on ? (
        <Text break="none" fg={fg} bold bg={MATCH_BG}>{seg}</Text>
      ) : (
        <Text break="none" fg={fg} bold={bold}>{seg}</Text>
      ),
    );
    i = j;
  }
  return spans;
};

// comm·pid spans. Sender is right-justified so it hugs the wire; target is
// left-justified so it trails the arrowhead. Target comm is bold — it's the
// one you're usually hunting for. commHits/pidHits light matched chars.
const endpoint = (comm, pid, { right, bold, commHits, pidHits }) => {
  const c = clip(comm || "?", 14);
  const pidDigits = `${pid}`;
  const pidStr = `·${pidDigits}`;
  const spans = [
    <Text break="none">{hl(c, commHits, BRIGHT, bold)}</Text>,
    <Text break="none" fg={DIM}>{"·"}{hl(pidDigits, pidHits, DIM, false)}</Text>,
  ];
  if (!right) return spans;
  const pad = Math.max(0, EP_W - c.length - pidStr.length);
  return [pad ? <Text>{" ".repeat(pad)}</Text> : null, ...spans];
};

// ──SIGNAME───▶  — dashes fill to a fixed width so the arrowhead (and the
// target column after it) always land on the same column.
const wire = (sig, sev, sigHits) => {
  const col = SEV_COLOR[sev];
  const avail = WIRE_W - 3; // "──" + "▶"
  const name = clip(sigName(sig), avail);
  const dash = "─".repeat(Math.max(0, avail - name.length));
  return (
    <Text break="none" fg={col}>
      {"──"}
      {hl(name, sigHits, col, true)}
      {dash}
      {"▶"}
    </Text>
  );
};

// The right-hand disposition tag: did the target catch it, let it hit the
// default action, or ignore it — and, for a caught signal that has returned,
// how long its handler ran. dispHits lights the matched chars of the word.
const dispSpan = (r, dispHits) => {
  if (r.disp === "caught")
    return (
      <Text break="none">
        <Text fg={CAUGHT}>{"  "}{hl("caught", dispHits, CAUGHT, false)}</Text>
        {r.durNs != null ? <Text fg={DIM}>{` ${dur(r.durNs)}`}</Text> : null}
      </Text>
    );
  if (r.disp === "ignored" || (!r.disp && wasIgnored(r.result)))
    return <Text break="none" fg={IGN}>{"  ⊘ "}{hl("ignored", r.disp ? dispHits : null, IGN, false)}</Text>;
  if (r.disp === "default") return <Text break="none" fg={DIM}>{"  "}{hl("default", dispHits, DIM, false)}</Text>;
  return null;
};

// Did this signal interrupt a blocked syscall? EINTR is the headline — the
// classic "my read() randomly failed" gremlin, made visible.
const intrSpan = (r) => {
  if (r.eintr === 1)
    return <Text bold fg={EINTR_C} break="none">{`  ↯ EINTR ${syscallName(r.intrSyscall)}`}</Text>;
  if (r.eintr === 2)
    return <Text fg={DIM} break="none">{`  ↺ restarted ${syscallName(r.intrSyscall)}`}</Text>;
  return null;
};

function Row({ r, now, selected, hits }) {
  const col = SEV_COLOR[r.sev];
  const fatalHit = isFatalBlow(r.sig, r.code, r.result);
  const tint = selected ? SEL : fatalHit ? "#ff2d5520" : undefined; // real deaths glow red

  const note = [];
  if (r.count > 1) note.push(<Text bold fg={col}>{`  ×${r.count}`}</Text>);
  note.push(<Text break="none" fg={DIM}>{"  "}{hl(r.src, hits?.src, DIM, false)}</Text>);
  note.push(intrSpan(r));
  note.push(dispSpan(r, hits?.disp));
  if (fatalHit) note.push(<Text bold fg={col}>{"  ☠"}</Text>);

  return (
    <Box height="1" direction="row" bg={tint}>
      <Text width="1" break="none" fg={SEL_BAR}>{selected ? GUTTER : " "}</Text>
      <Text width={`${TIME_W}`} break="none" fg={DIM}>{`${rjust(ago((now - r.ts) / 1e9), TIME_W - 1)} `}</Text>
      <Box width={`${EP_W}`} overflow="hidden"><Text break="none">{endpoint(r.sComm, r.sPid, { right: true, commHits: hits?.sComm, pidHits: hits?.sPid })}</Text></Box>
      <Box width={`${WIRE_W}`} overflow="hidden">{wire(r.sig, r.sev, hits?.sig)}</Box>
      <Box width={`${EP_W}`} overflow="hidden"><Text break="none">{endpoint(r.tComm, r.tPid, { bold: true, commHits: hits?.tComm, pidHits: hits?.tPid })}</Text></Box>
      <Text width="1fr" break="none" overflow="hidden">{note}</Text>
    </Box>
  );
}

const Header = () => (
  <Text height="1" break="none" fg={FAINT}>
    {" " + rjust("WHEN", TIME_W) + rjust("SENDER", EP_W) + ljust("  SIGNAL", WIRE_W) + ljust("TARGET", EP_W) + "NOTE"}
  </Text>
);

export default function Feed({ view, rows, sel, filtered }) {
  return (
    <Box height="1fr" overflow="hidden">
      <Header />
      {() => {
        const v = view.get();
        const si = sel ? sel.get() : -1;
        const list = v.rows.slice(0, Math.max(1, rows));
        if (!list.length) {
          const q = filter.get();
          const msg = q
            ? `  nothing matches “${q}” — Esc to clear the search`
            : filtered && filtered.get()
              ? "  no interrupted syscalls yet — nothing has hit EINTR"
              : "  waiting for signals…";
          return <Text fg={DIM}>{msg}</Text>;
        }
        const q = filter.get();
        return list.map((r, i) => <Row r={r} now={v.latestTs} selected={i === si} hits={q ? fieldHits(q, r) : null} />);
      }}
    </Box>
  );
}
