// The signal picker — a modal list of the standard signals, each toggleable
// between shown and muted. Toggling flips that signal's bit in the kernel
// mute_mask (via toggleMute → DataSec.patch), so the choice takes effect
// in-kernel immediately: a muted signal is dropped before it reaches the feed.
// Pure UI apart from the toggle call — it reads `muteMask` and the live feed so
// each row shows its current state and how many of that signal we've seen.
import { Box, Text } from "yeet:tui";
import { SEV_COLOR, severity, sigName } from "@/lib/signals.js";
import { muteMask, toggleMute } from "@/probes/sigwire.js";
import { count } from "@/lib/format.js";

const BRIGHT = "#e6f0ea";
const DIM = "#6a7a72";
const FAINT = "#3a4640";
const SEL = "#123f3a"; // highlighted-row band, matching the feed cursor
const GREEN = "#3ddc84"; // shown / cursor accent
const AMBER = "#ffb020"; // muted

// The pickable set: the 31 named signals. The mask supports the real-time
// signals too, but they're rarely something you'd hand-mute, so we keep the
// list to the ones people recognise. Index i ⇒ signal i+1.
export const PICK_SIGNALS = Array.from({ length: 31 }, (_, i) => i + 1);

const bit = (n) => 1n << BigInt(n);

export default function Picker({ feed, cursor, rows }) {
  return (
    <Box direction="column" width="1fr" height="1fr" overflow="hidden">
      <Text height="1" break="none" overflow="hidden">
        <Text bold fg={GREEN}>{" ⌁ signals"}</Text>
        <Text fg={DIM}>{"  ↑↓/# jump · space · a all · esc"}</Text>
      </Text>
      {() => {
        const mask = muteMask.get();
        const cur = cursor.get();
        const bySig = feed.get().bySig;
        const body = Math.max(1, rows);
        // Scroll a window so the cursor stays visible when the list is taller
        // than the modal.
        let start = 0;
        if (PICK_SIGNALS.length > body) {
          start = Math.min(Math.max(0, cur - (body >> 1)), PICK_SIGNALS.length - body);
        }
        return PICK_SIGNALS.slice(start, start + body).map((sig, i) => {
          const idx = start + i;
          const muted = (mask & bit(sig)) !== 0n;
          const on = idx === cur;
          const col = SEV_COLOR[severity(sig)];
          const n = bySig[sig] || 0;
          return (
            <Box height="1" direction="row" bg={on ? SEL : undefined} onClick={() => { cursor.set(idx); toggleMute(sig); }}>
              <Text width="2" break="none" fg={GREEN}>{on ? "▌" : " "}</Text>
              <Text width="7" break="none" bold fg={muted ? AMBER : GREEN}>{muted ? "muted" : "shown"}</Text>
              <Text width="2" break="none" fg={col}>{"●"}</Text>
              <Text width="fit" break="none">
                <Text bold fg={muted ? DIM : BRIGHT}>{sigName(sig)}</Text>
                <Text fg={FAINT}>{` ${sig}`}</Text>
              </Text>
              <Box width="1fr" />
              <Text width="10" break="none" overflow="hidden" fg={n ? DIM : FAINT}>{n ? `${count(n)} seen` : ""}</Text>
            </Box>
          );
        });
      }}
    </Box>
  );
}
