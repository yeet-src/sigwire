// Pure signal metadata — no BPF, no reactive signals. Maps a signal number to
// its name and a *severity class*, maps an si_code to the syscall/source that
// raised it, and names the kernel's delivery disposition. The severity class
// drives colour everywhere in the UI, so it lives in exactly one place.

// Generic Linux numbering (x86/arm64 share it). Real-time signals (≥ SIGRTMIN)
// are named below; everything else is a fixed table.
const NAMES = {
  1: "HUP", 2: "INT", 3: "QUIT", 4: "ILL", 5: "TRAP", 6: "ABRT", 7: "BUS",
  8: "FPE", 9: "KILL", 10: "USR1", 11: "SEGV", 12: "USR2", 13: "PIPE",
  14: "ALRM", 15: "TERM", 16: "STKFLT", 17: "CHLD", 18: "CONT", 19: "STOP",
  20: "TSTP", 21: "TTIN", 22: "TTOU", 23: "URG", 24: "XCPU", 25: "XFSZ",
  26: "VTALRM", 27: "PROF", 28: "WINCH", 29: "IO", 30: "PWR", 31: "SYS",
};

const SIGRTMIN = 34;

export function sigName(sig) {
  if (NAMES[sig]) return "SIG" + NAMES[sig];
  if (sig >= SIGRTMIN && sig <= 64) {
    const off = sig - SIGRTMIN;
    return off === 0 ? "SIGRTMIN" : `SIGRTMIN+${off}`;
  }
  return `SIG${sig}`;
}

// Severity class → drives colour and the "lethal" tally. Ordering of the ifs
// matters: KILL is called out on its own, then the core-dumping crashes, then
// the catchable terminators, then the job-control and informational buckets.
const CRASH = new Set([3, 4, 5, 6, 7, 8, 11, 31]); // QUIT ILL TRAP ABRT BUS FPE SEGV SYS
const STOP = new Set([19, 20, 21, 22]); // STOP TSTP TTIN TTOU
const INFO = new Set([17, 23, 28]); // CHLD URG WINCH

export function severity(sig) {
  if (sig === 9) return "kill"; // uncatchable, unignorable
  if (sig >= SIGRTMIN) return "rt";
  if (CRASH.has(sig)) return "fatal"; // default action: terminate + core dump
  if (sig === 18) return "cont";
  if (STOP.has(sig)) return "stop";
  if (INFO.has(sig)) return "info"; // low-signal housekeeping
  if (sig === 10 || sig === 12) return "user"; // USR1/USR2
  return "term"; // default action terminates (HUP INT TERM PIPE ALRM …)
}

// A *genuinely* fatal delivery. signal_generate fires at generation, before
// delivery, so we can't see whether the target has a handler — most signals
// are therefore ambiguous (a SIGTERM may well be caught). Two cases are not:
// SIGKILL is uncatchable, and a core-dumping signal raised by the kernel
// itself (a fault: SEGV_MAPERR, or SI_KERNEL) is a real crash. Those are what
// the ☠ badge and the "fatal" counter mean — deliberately conservative, so the
// number tracks actual deaths and crashes rather than every terminate-class
// signal a runtime happens to raise and handle internally.
export function isFatalBlow(sig, code, result) {
  if (result !== 0) return false; // not delivered
  if (sig === 9) return true; // SIGKILL — uncatchable
  if (severity(sig) !== "fatal") return false; // only core-dumping signals
  return code > 0 || code === 128; // kernel/fault generated (not a user kill)
}

// Severity → colour. A CRT-patchbay palette: phosphor greens and ambers with
// hot red reserved for the signals that end processes.
export const SEV_COLOR = {
  kill: "#ff2d55", // hot red
  fatal: "#ff453a", // red
  term: "#ff9f0a", // amber
  stop: "#ffd60a", // yellow
  cont: "#30d158", // green
  user: "#64d2ff", // cyan
  info: "#7f8c8d", // muted grey (the noise)
  rt: "#bf5af2", // violet
};

export const sigColor = (sig) => SEV_COLOR[severity(sig)];

// si_code → who raised the signal. The negative codes are the userspace
// syscall families; 0x80 is the kernel; positive codes are signal-specific
// fault reasons (SEGV_MAPERR, CLD_EXITED, …) i.e. synchronously generated.
export function codeName(code) {
  switch (code) {
    case 0: return "SI_USER";
    case 128: return "SI_KERNEL";
    case -1: return "SI_QUEUE";
    case -2: return "SI_TIMER";
    case -3: return "SI_MESGQ";
    case -4: return "SI_ASYNCIO";
    case -6: return "SI_TKILL";
  }
  return code > 0 ? `fault (code ${code})` : `code ${code}`;
}

export function source(code) {
  switch (code) {
    case 0: return "kill"; // SI_USER — kill(2) / raise(3)
    case -6: return "tgkill"; // SI_TKILL — tgkill/tkill/pthread_kill
    case -1: return "queue"; // SI_QUEUE — sigqueue(3)
    case -2: return "timer"; // SI_TIMER — POSIX timers
    case 128: return "kernel"; // SI_KERNEL
  }
  return code > 0 ? "fault" : "other";
}

// Kernel TRACE_SIGNAL_* disposition codes (include/trace/events/signal.h).
const RESULT = { 0: "delivered", 1: "ignored", 2: "pending", 3: "overflow", 4: "loseinfo" };
export const resultName = (r) => RESULT[r] ?? `result ${r}`;
export const wasIgnored = (r) => r === 1;

// --- the delivery side (from signal_deliver) ----------------------------

// sa_handler at delivery: 0 = SIG_DFL (default action), 1 = SIG_IGN (ignored),
// anything else is the address of a userspace handler ⇒ the target caught it.
export function disposition(handler) {
  const h = typeof handler === "bigint" ? handler : BigInt(handler || 0);
  return h === 0n ? "default" : h === 1n ? "ignored" : "caught";
}

// What SIG_DFL actually does for this signal — the fate of a signal the target
// doesn't handle. Drives how loud a "default" disposition reads.
export function defaultAction(sig) {
  if (sig === 18) return "continue";
  if (STOP.has(sig)) return "stop";
  if (INFO.has(sig)) return "ignore";
  if (CRASH.has(sig)) return "core dump";
  return "terminate";
}

// sigaction flags (x86-64 asm-generic). SA_RESTORER is glibc plumbing on every
// handler, so it's intentionally omitted — it carries no signal about intent.
const SA_FLAGS = [
  [0x00000004, "SA_SIGINFO"],
  [0x10000000, "SA_RESTART"],
  [0x40000000, "SA_NODEFER"],
  [0x80000000, "SA_RESETHAND"],
  [0x08000000, "SA_ONSTACK"],
  [0x00000001, "SA_NOCLDSTOP"],
  [0x00000002, "SA_NOCLDWAIT"],
];

export function decodeFlags(saFlags) {
  const f = Number(saFlags || 0);
  return SA_FLAGS.filter(([bit]) => f & bit).map(([, name]) => name);
}

// A kernel sigset_t packs signal N into bit (N-1). Decode the target's blocked
// mask into the signal names it's currently masking.
export function decodeBlocked(blocked) {
  const b = typeof blocked === "bigint" ? blocked : BigInt(blocked || 0);
  const out = [];
  for (let s = 1; s <= 64; s++) if (b & (1n << BigInt(s - 1))) out.push(sigName(s));
  return out;
}

// --- EINTR: the syscall a signal interrupted -----------------------------

// x86-64 syscall numbers — the blocking ("slow") calls that actually surface
// EINTR, plus a few common neighbours. Non-x86-64 arches fall back to the raw
// number, so the tag is never wrong, just less pretty.
const SYSCALLS = {
  0: "read", 1: "write", 2: "open", 7: "poll", 16: "ioctl", 19: "readv",
  20: "writev", 22: "pipe", 23: "select", 34: "pause", 35: "nanosleep",
  42: "connect", 43: "accept", 44: "sendto", 45: "recvfrom", 46: "sendmsg",
  47: "recvmsg", 61: "wait4", 65: "semop", 69: "msgsnd", 70: "msgrcv",
  72: "fcntl", 73: "flock", 85: "creat", 128: "rt_sigtimedwait",
  202: "futex", 220: "semtimedop", 230: "clock_nanosleep", 232: "epoll_wait",
  247: "waitid", 270: "pselect6", 271: "ppoll", 281: "epoll_pwait",
  288: "accept4", 295: "preadv", 296: "pwritev", 299: "recvmmsg",
  307: "sendmmsg", 424: "pidfd_send_signal",
};

export const syscallName = (nr) => (nr < 0 ? "" : SYSCALLS[nr] || `syscall ${nr}`);

// eintr verdict from the BPF side: 0 none, 1 EINTR, 2 restarted (SA_RESTART).
export const EINTR = 1;
export const RESTARTED = 2;
