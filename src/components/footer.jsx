// Key-hint / search rail. One row tinted as the rail (its own bg — reliable
// full width, unlike a fill of plain spaces which the text engine strips).
// Three states:
//   • searching    → live "/query▏" prompt + match count
//   • search set   → the active query + how to edit/clear it, then the hints
//   • normal       → the key hints
import { Box, Text } from "yeet:tui";

const RAIL = "#101613";
const CAP = "#20302a";
const GLYPH = "#3ddc84";
const LABEL = "#6a7a72";
const QUERY = "#39d0d8"; // the filter query text
const FAINT = "#3a4640";

const hint = (keys, label) => [
  <Text bg={CAP} bold fg={GLYPH}>{` ${keys} `}</Text>,
  <Text fg={LABEL}>{` ${label}   `}</Text>,
];

// The key hints shown in normal / filter-set states.
const KEYS = [...hint("p", "pause"), ...hint("↑↓", "inspect"), ...hint("e", "EINTR"), ...hint("s", "signals"), ...hint("q", "quit")];

export default function Footer({ filtering, filter, visible, feed }) {
  return (
    <Box height="1" direction="row" bg={RAIL}>
      <Text break="none" overflow="hidden">
        {() => {
          const q = filter.get();

          // Filter mode: the live prompt + match count.
          if (filtering.get()) {
            const shown = visible.get().rows.length;
            const total = feed.get().rows.length;
            return [
              <Text bg={CAP} bold fg={GLYPH}>{" / "}</Text>,
              <Text fg={QUERY}>{` ${q}`}</Text>,
              <Text bold fg={GLYPH}>{"▏"}</Text>, // cursor
              <Text fg={LABEL}>{`   ${shown}/${total} match${shown === 1 ? "" : "es"}   ·   ⏎ accept   ·   esc clear`}</Text>,
            ];
          }

          // Search set (not typing): show the active query + how to change it.
          if (q) {
            return ["  ", <Text fg={LABEL}>{"search "}</Text>, <Text fg={QUERY}>{`“${q}”  `}</Text>, ...hint("/", "edit"), ...hint("esc", "clear"), ...KEYS];
          }

          // Normal: hints, with `/` to start a search.
          return ["  ", ...hint("/", "search"), ...KEYS];
        }}
      </Text>
      <Box width="1fr" />
      <Text break="none" fg={FAINT}>{"signal switchboard · tracepoint/signal/signal_generate  "}</Text>
    </Box>
  );
}
