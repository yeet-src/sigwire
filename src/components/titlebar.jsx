// Status rail: brand, live signal rate, running totals, the lethal counter,
// and how many signals are muted in the kernel. A live / paused badge is pinned
// to the right edge. One row, tinted via its own bg.
import { Box, Text } from "yeet:tui";
import { count } from "@/lib/format.js";
import { eintrOnly, mutedCount, paused } from "@/probes/sigwire.js";

const RAIL = "#101613";
const GREEN = "#3ddc84";
const BRIGHT = "#e6f0ea";
const DIM = "#6a7a72";
const AMBER = "#ffb020";
const RED = "#ff2d55";

const sep = () => <Text fg="#28322c">{"  │  "}</Text>;

export default function TitleBar({ feed }) {
  return (
    <Box height="1" direction="row" bg={RAIL}>
      <Text break="none">
        {() => {
          const s = feed.get();
          const muted = mutedCount.get();
          return [
            <Text bold fg={GREEN}>{" ⌁ SIGWIRE "}</Text>, sep(),
            <Text bold fg={BRIGHT}>{Math.round(s.rate)}</Text>, <Text fg={DIM}>{" sig/s"}</Text>, sep(),
            <Text fg={DIM}>{"Σ "}</Text>, <Text bold fg={BRIGHT}>{count(s.total)}</Text>, sep(),
            <Text bold fg={s.fatal ? RED : DIM}>{`☠ ${count(s.fatal)}`}</Text>, <Text fg={DIM}>{" fatal"}</Text>, sep(),
            <Text bold fg={s.eintr ? "#ff8c1a" : DIM}>{`↯ ${count(s.eintr || 0)}`}</Text>, <Text fg={DIM}>{" eintr"}</Text>, sep(),
            <Text bold fg={muted ? AMBER : DIM}>{`${muted}`}</Text>, <Text fg={DIM}>{" muted"}</Text>,
          ];
        }}
      </Text>
      <Box width="1fr" />
      <Text break="none">
        {() => [
          eintrOnly.get() ? <Text bold fg="#ff8c1a">{"↯ EINTR only  "}</Text> : null,
          paused.get() ? <Text bold fg={AMBER}>{"⏸ PAUSED "}</Text> : <Text fg={GREEN}>{"● live "}</Text>,
        ]}
      </Text>
    </Box>
  );
}
