// Shared BPF object. The single .bpf.c unit is compiled and linked into
// bin/probe.bpf.o and loaded once here; the data probe (sigwire.js) imports
// this `control` and attaches its maps to it. All binds must happen before
// the single start(), so they live together here.
import { BpfObject } from "yeet:bpf";

// `base: import.meta.dirname` resolves against the running bundle.
const probe = new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname });

export const control = await probe
  .bind("events", { kind: "ringbuf", btf_struct: "signal_event" }) // generation stream
  .bind("dispatch", { kind: "ringbuf", btf_struct: "dispatch_event" }) // delivery + handler-return
  .bind("probe.data", { kind: "data" }) // the mute-mask knob (.data section)
  .start(); // the tracepoints auto-attach
