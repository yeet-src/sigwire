// The side rail: what's flying across the wire, in aggregate. A leaderboard of
// signals by volume (coloured by severity, with a mini bar), then a breakdown
// by source — who's doing the signalling: kill(2), tgkill, the kernel, timers.
// Pure UI over the `feed` snapshot's running tallies.
import { Box, Text } from "yeet:tui";
import { SEV_COLOR, severity, sigName } from "@/lib/signals.js";
import { count, ljust } from "@/lib/format.js";

const HEAD = "#2a8f5a";
const BRIGHT = "#e6f0ea";
const DIM = "#5f6f68";
const FAINT = "#333d38";
const PANEL = "#0c110f";
const BAR_W = 10;

// Fixed display order + labels. kill/tgkill always show (they're the point);
// the rest appear once they've happened.
const SOURCES = [
  ["kill", "kill(2)"],
  ["tgkill", "tgkill"],
  ["queue", "sigqueue"],
  ["timer", "timer"],
  ["kernel", "kernel"],
  ["fault", "fault"],
  ["other", "other"],
];

// disposition key → label + colour (matches the feed's disposition tags)
const DISPOS = [
  ["caught", "caught", "#5fe08a"],
  ["default", "default", "#e6f0ea"],
  ["ignored", "ignored", "#9a8a4a"],
];

export default function Tally({ feed, rows }) {
  return (
    <Box height="1fr" overflow="hidden" bg={PANEL}>
      {() => {
        const s = feed.get();
        const out = [];

        out.push(<Text height="1" break="none" fg={HEAD} bold>{" TOP SIGNALS"}</Text>);
        const sigs = Object.entries(s.bySig)
          .map(([k, v]) => [+k, v])
          .sort((a, b) => b[1] - a[1]);
        const peak = sigs.length ? sigs[0][1] : 1;
        const budget = Math.max(3, rows - SOURCES.length - 4);
        if (!sigs.length) out.push(<Text height="1" fg={DIM}>{"  —"}</Text>);
        for (const [sig, n] of sigs.slice(0, budget)) {
          const col = SEV_COLOR[severity(sig)];
          const filled = Math.max(1, Math.round((n / peak) * BAR_W));
          out.push(
            <Text height="1" break="none">
              <Text fg={col} bold>{` ${ljust(sigName(sig), 11)}`}</Text>
              <Text fg={col}>{"█".repeat(filled)}</Text>
              <Text fg={FAINT}>{"·".repeat(BAR_W - filled)}</Text>
              <Text fg={DIM}>{` ${count(n)}`}</Text>
            </Text>,
          );
        }

        out.push(<Text height="1">{" "}</Text>);
        out.push(<Text height="1" break="none" fg={HEAD} bold>{" BY SOURCE"}</Text>);
        for (const [key, label] of SOURCES) {
          const n = s.bySrc[key] || 0;
          if (!n && key !== "kill" && key !== "tgkill") continue;
          out.push(
            <Text height="1" break="none">
              <Text fg={DIM}>{` ${ljust(label, 10)}`}</Text>
              <Text fg={n ? BRIGHT : FAINT} bold={!!n}>{count(n)}</Text>
            </Text>,
          );
        }

        out.push(<Text height="1">{" "}</Text>);
        out.push(<Text height="1" break="none" fg={HEAD} bold>{" DELIVERY"}</Text>);
        const d = s.byDisp || {};
        for (const [key, label, color] of DISPOS) {
          const n = d[key] || 0;
          out.push(
            <Text height="1" break="none">
              <Text fg={n ? color : DIM}>{` ${ljust(label, 10)}`}</Text>
              <Text fg={n ? BRIGHT : FAINT} bold={!!n}>{count(n)}</Text>
            </Text>,
          );
        }
        const ei = s.eintr || 0;
        out.push(
          <Text height="1" break="none">
            <Text fg={ei ? "#ff8c1a" : DIM}>{` ${ljust("↯ eintr", 10)}`}</Text>
            <Text fg={ei ? BRIGHT : FAINT} bold={!!ei}>{count(ei)}</Text>
          </Text>,
        );
        return out;
      }}
    </Box>
  );
}
