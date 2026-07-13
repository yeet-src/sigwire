// Detail panel for the selected signal — shown in place of the tally rail when
// you pause (`p`) and pick a row. This is the home for the delivery-side facts
// that don't fit on a feed line: whether the target *caught* it, how long its
// handler ran, the sigaction flags, and the full set of signals the target was
// blocking at the moment of delivery.
import { Box, Text } from "yeet:tui";
import {
  SEV_COLOR,
  codeName,
  decodeBlocked,
  decodeFlags,
  defaultAction,
  resultName,
  sigName,
  syscallName,
} from "@/lib/signals.js";
import { clip, dur } from "@/lib/format.js";

const HEAD = "#2a8f5a";
const BRIGHT = "#e6f0ea";
const DIM = "#5f6f68";
const FAINT = "#333d38";
const PANEL = "#0c110f";
const CAUGHT = "#5fe08a";
const IGN = "#9a8a4a";
const EINTR_C = "#ff8c1a";
const W = 30;

const ep = (comm, pid) => clip(`${comm}·${pid}`, W - 8);

const kv = (k, v, color) => (
  <Text height="1" break="none">
    <Text fg={DIM}>{` ${k.padEnd(8)}`}</Text>
    <Text fg={color || BRIGHT}>{v}</Text>
  </Text>
);

const gap = () => <Text height="1">{" "}</Text>;
const head = (t) => <Text height="1" break="none" fg={HEAD} bold>{` ${t}`}</Text>;

// How the target handled it, in words — the answer to "did it catch it?".
function handling(r) {
  if (!r.disp) return ["not observed", DIM];
  if (r.disp === "caught") return ["caught", CAUGHT];
  if (r.disp === "ignored") return ["ignored", IGN];
  return [`default → ${defaultAction(r.sig)}`, BRIGHT];
}

export default function Detail({ view, sel }) {
  return (
    <Box height="1fr" overflow="hidden" bg={PANEL}>
      {() => {
        const r = view.get().rows[sel.get()];
        if (!r) return <Text fg={DIM}>{" (no selection)"}</Text>;

        const col = SEV_COLOR[r.sev];
        const [hword, hcol] = handling(r);
        const flags = decodeFlags(r.saFlags);
        const blocked = decodeBlocked(r.blocked);

        const out = [
          head("SIGNAL"),
          <Text height="1" break="none">
            <Text fg={col} bold>{`  ${sigName(r.sig)}`}</Text>
            <Text fg={DIM}>{`  (${r.sig})  ${r.sev}`}</Text>
          </Text>,
          gap(),
          kv("from", ep(r.sComm, r.sPid)),
          kv("to", ep(r.tComm, r.tPid)),
          gap(),
          head("RAISED"),
          kv("via", r.src),
          kv("code", codeName(r.code)),
          kv("scope", r.group ? "process (group)" : "thread"),
          kv("result", resultName(r.result)),
          gap(),
          head("DELIVERY"),
          kv("handled", hword, hcol),
        ];

        if (r.eintr === 1) out.push(kv("syscall", `EINTR ← ${syscallName(r.intrSyscall)}`, EINTR_C));
        else if (r.eintr === 2) out.push(kv("syscall", `restarted ${syscallName(r.intrSyscall)}`, DIM));

        if (r.disp === "caught") {
          out.push(kv("handler", `0x${r.handler.toString(16)}`.slice(0, W - 10)));
          out.push(kv("ran", r.durNs != null ? dur(r.durNs) : "…", r.durNs != null ? CAUGHT : DIM));
          out.push(
            <Text height="1" break="none">
              <Text fg={DIM}>{" flags   "}</Text>
              <Text fg={flags.length ? BRIGHT : FAINT}>{flags.length ? flags[0] : "—"}</Text>
            </Text>,
          );
          for (const f of flags.slice(1)) out.push(<Text height="1" break="none" fg={BRIGHT}>{`         ${f}`}</Text>);
        }

        out.push(gap());
        out.push(head("TARGET BLOCKS"));
        if (!r.disp) out.push(<Text height="1" fg={FAINT}>{"  (mask not observed)"}</Text>);
        else if (!blocked.length) out.push(<Text height="1" fg={FAINT}>{"  nothing"}</Text>);
        else {
          // pack the blocked signal names a few per line to fit the rail
          let line = " ";
          for (const name of blocked) {
            if ((line + " " + name).length > W - 1) { out.push(<Text height="1" break="none" fg={BRIGHT}>{line}</Text>); line = " "; }
            line += ` ${name}`;
          }
          if (line.trim()) out.push(<Text height="1" break="none" fg={BRIGHT}>{line}</Text>);
        }
        return out;
      }}
    </Box>
  );
}
