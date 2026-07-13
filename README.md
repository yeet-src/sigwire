# `sigwire`

> **`tail -f` for signals.** Every signal any process on the box raises — who sent it, who it hit, which signal, how it was raised (`kill(2)`, the kernel, a POSIX timer), whether the target caught it and how long its handler ran, whether it tore a blocked syscall out with `EINTR` — decoded off the kernel's signal tracepoints and streamed live to your terminal. No `strace -f` on one pid, no `ptrace`, no cooperation from the processes involved.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="yeet + eBPF">
  <img src="https://img.shields.io/badge/license-Dual%20BSD%2FGPL-3DA639" alt="Dual BSD/GPL">
  <a href="https://discord.gg/JxVseaAVAU"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

<p align="center">
  <img src="assets/sigwire.gif" alt="sigwire streaming live signals as a switchboard in the terminal">
</p>

**`sigwire` turns the kernel's signal machinery into a live patchbay: each line is `sender ──SIGNAL──▶ target`, coloured by severity, tagged with how it was raised, whether the target **caught** it (and how long its handler ran), whether it **interrupted a blocked syscall** (`↯ EINTR read`), collapsed to `×N` when something spams, and marked `☠` when it's a genuine killing blow.** A side rail tallies what's flying across the wire; pause and pick a row to inspect the full picture — disposition, handler address, `sigaction` flags, and the signals the target was blocking at that instant.

Because it hooks the kernel's *tracepoints*, not any one process, a single run watches every signal on the host at once — your app, a supervisor, the kernel's own fault machinery — with none of them aware they're being traced.

> [!TIP]
> **Two sides of every signal.** sigwire watches both `signal:signal_generate` (the *sender's* view — who raised what, the switchboard line) and `signal:signal_deliver` (the *target's* view — did it catch it, with which handler and flags, what was it blocking, and did it interrupt a syscall). Two more hooks — `rt_sigreturn(2)` and the syscall-exit tracepoint — time the handler and catch EINTR. It's all correlated back into one row. This split is also why the `☠ fatal` count is deliberately conservative (see [What counts as fatal](#what-counts-as-fatal)): generation happens before delivery, so the sender side can't know a signal's fate — only the delivery side can, and only for the cases it observes.

## Quick start

```sh
curl -fsSL https://yeet.cx | sh              # install the yeet daemon (one time)
yeet run github:yeet-src/sigwire             # run the dashboard (the daemon does the privileged BPF load)
```
[Manual install guide](https://yeet.cx/docs/manual-installation) | Linux only

Nothing to configure — signals are constant background traffic on any box, so rows start landing at the top immediately. Want to make some yourself? `kill -USR1 <pid>`, `Ctrl-C` a foreground job, or start any managed runtime and watch its GC/scheduler ping its own threads (`↯ EINTR futex` scrolling by).

## Controls

The feed follows the newest signal by default; select a row or pause and it holds still while data keeps flowing underneath.

| key | action |
| --- | ------ |
| `p` · `Space` | pause / resume the feed (freeze it to read) |
| `↑`/`↓`, `k`/`j` | pause and inspect a row — opens the detail panel |
| `/` | fuzzy filter — matches process, pid, signal, source, and disposition; matched characters highlight live |
| `e` | filter to **interrupted syscalls only** (`↯ EINTR` / `↺ restarted`) |
| `s` | open the **signal picker** — mute or show any signal, live |
| `Esc` | back out one layer — clear the filter / close the picker / drop the selection, then quit |
| `q` | quit |

## What you're looking at

Each row is one generated signal, newest at the top:

```
 WHEN            SENDER  SIGNAL        TARGET               NOTE
  now       bash·4402──SIGINT───▶  node·8813        kill(2)  ↯ EINTR read  caught 41µs
 1.2s    systemd·1──────SIGTERM──▶  nginx·1291       kill(2)  caught 1.2ms
 3.4s     kernel·8813──SIGSEGV──▶  chrome·8813       fault    default  ☠
 4.1s   postgres·507──SIGUSR1───▶  postgres·509 ×6  kill(2)  caught 9µs
```

Each row is one block: the **sender → target** are `comm·pid` (the sender is whoever raised the signal, `current`; the target is who it's aimed at), the **wire** in the middle carries the signal name coloured by severity, `×N` folds a burst of the identical signal into one line, and the **note** on the right gives the source, then any syscall interruption, then the disposition.

Each row is frozen the moment its delivery resolves and never mutates again — so a burst scrolls past as a stable log, not a flickering aggregate.

**The wire is coloured by severity** on the same 256-color palette as the rest of the UI:

| severity | signals | colour |
|---|---|---|
| kill | `SIGKILL` | hot red |
| fatal (core-dumping) | `SEGV` `BUS` `ABRT` `ILL` `FPE` `TRAP` `SYS` `QUIT` | red |
| terminating | `TERM` `INT` `HUP` `PIPE` `ALRM` … | amber |
| job control | `STOP` `TSTP` `TTIN` `TTOU` | yellow |
| continue | `CONT` | green |
| user | `USR1` `USR2` | cyan |
| real-time | `SIGRTMIN+n` | violet |
| housekeeping | `CHLD` `URG` `WINCH` … | grey |

The **note** is the source (`kill(2)`, `tgkill`, `sigqueue`, `timer`, `kernel`, `fault`); then, if it interrupted a blocked syscall, `↯ EINTR read` (or `↺ restarted read` when `SA_RESTART` auto-resumed it); then the **disposition** — `caught 41µs` (a handler ran, and how long it took), `default` (no handler, the default action applied), or `⊘ ignored`. A `☠` marks a genuine killing blow (see [What counts as fatal](#what-counts-as-fatal)).

> [!NOTE]
> **`↯ EINTR` is the one to watch.** A signal that lands while a thread is parked in a slow syscall (`read`, `poll`, `accept`, `futex`, `nanosleep`, …) yanks it out: the syscall returns `-1` / `EINTR` and, unless the handler set `SA_RESTART`, it does **not** resume — the app has to retry. Forgetting that is a classic, maddening, timing-dependent bug ("why did my `read()` fail *once*?"). sigwire shows it happening, live, and which syscall took the hit. Press **`e`** to hide everything else and watch only the interrupts.

The rail on the right is the aggregate view: **top signals** by volume, a breakdown **by source**, and a **delivery** tally — how many signals were caught vs. hit their default vs. ignored.

## Inspect a signal

Press `↑`/`↓` (or `p`) to freeze the feed and select a row; the rail turns into a detail panel with everything the delivery side knows about that exact signal:

```
 SIGNAL
  SIGUSR1  (10)  user
 from    ctarget·3980913
 to      ctarget·3980913
 RAISED
  via     tgkill
  code    SI_TKILL
  scope   thread
  result  delivered
 DELIVERY
  handled caught
  syscall EINTR ← read
  handler 0x55f0a1c3
  ran     3.0ms
  flags   SA_SIGINFO
 TARGET BLOCKS
  SIGINT SIGQUIT SIGTERM
```

- **handled** — `caught` (ran a userspace handler), `default` (→ the default action: terminate / core dump / stop / ignore), or `ignored`.
- **syscall** — if this signal interrupted a blocked syscall: `EINTR ← read` (userspace saw `EINTR`) or `restarted read` (`SA_RESTART` resumed it transparently).
- **ran** — how long the handler executed, measured from delivery to the `rt_sigreturn(2)` that ends it. (Runtimes that only latch a flag in the C handler and do the real work later — CPython, Go — show a tiny time here; that's them, not sigwire.)
- **flags** — the `sigaction` flags on the handler (`SA_RESTART`, `SA_SIGINFO`, `SA_NODEFER`, …).
- **TARGET BLOCKS** — the signals the target had blocked (its `sigprocmask`) at the moment of delivery, straight off its `task_struct`.

`Esc` closes the inspector; `p` resumes the live feed.

## What counts as fatal

The `☠ fatal` counter and the `☠` row badge are intentionally strict. Because `signal_generate` fires at *generation*, sigwire can't see whether the target installed a handler — a `SIGTERM` might be caught and turned into a clean shutdown, or ignored entirely. So it only counts a death when it's unambiguous:

- **`SIGKILL`** delivered — uncatchable, unignorable, always fatal; **or**
- a **core-dumping signal** (`SEGV`/`BUS`/`ABRT`/`ILL`/`FPE`/`TRAP`/`SYS`/`QUIT`) that the **kernel itself raised** (a synchronous fault, not a userspace `kill`).

Everything else — a `SIGTERM` from `systemd`, a `SIGINT` from your `Ctrl-C`, a runtime's `SIGPWR` to its own threads — is shown and coloured, but not counted as a death, because it probably wasn't one.

## The signal picker (a live kernel knob)

Three signals are pure background hum on any busy box: `SIGCHLD` (every child reap), `SIGURG` (Go's async-preemption heartbeat), and `SIGWINCH` (terminal resizes, broadcast to every foreground process). sigwire mutes those three **in the kernel** by default so the feed is the interesting traffic — but which signals are noise is your call.

Press `s` to open the **signal picker**: a modal list of every signal with its live severity colour and how many you've seen, each toggleable between `shown` and `muted`. Arrow to one (or **type its number** — `1`, `5` → jump to 15) and hit `space`, and that signal flips instantly. `a` toggles them **all** at once. The titlebar's `muted` count tracks how many are hidden.

This is the two-way half of the demo: the mute mask is a `__u64` global in the running BPF program's `.data` section, and toggling a row patches the matching bit through `DataSec.patch()` while the program keeps running. The kernel drops muted signals before they ever reach the ring buffer, so muting costs you nothing — and unmuting brings a signal back mid-stream with no reload.

## How it works

The core is [`src/bpf/sigwire.bpf.c`](src/bpf/sigwire.bpf.c) + [`src/bpf/deliver.bpf.c`](src/bpf/deliver.bpf.c) (kernel, linked into one object) and [`src/probes/sigwire.js`](src/probes/sigwire.js) (userspace). Everything is correlated by `(target tid, signal)`.

### The BPF side

Two source files link into a single loadable object, `bin/probe.bpf.o`, with four tracepoint programs:

| Program | Attached to | What it captures |
|---|---|---|
| `on_signal_generate` | `signal:signal_generate` | the sender (`current`) + target (`comm`/`pid`), the signal, `si_code`, `group` flag, `result` — dropped in-kernel if the signal's bit is set in the live `mute_mask` |
| `on_signal_deliver` | `signal:signal_deliver` | the target's disposition (`sa_handler`), `sa_flags`, and — off `task_struct` — its `blocked` sigset; stamps delivery for handler timing |
| (rt_sigreturn) | `syscalls:sys_enter_rt_sigreturn` | diffs against the stamped delivery for the handler's run time |
| (sys_exit) | `raw_syscalls:sys_exit` | records the rare `-ERESTART*` return so the next `signal_deliver` resolves it into `EINTR`/`restarted` + the interrupted syscall number |

Maps connect kernel to userspace:

- `events` — `RINGBUF`, one `signal_event` per generation.
- `dispatch` — `RINGBUF`, one `dispatch_event` per delivery / handler-return.
- `mute_mask` — a `__u64` global in the `.data` section; the picker patches individual bits to drop signals in-kernel.
- `handler_start` / `restart_pending` — `HASH` keyed by tid, per-thread scratch that pairs a delivery with its `rt_sigreturn`, and a syscall's `-ERESTART*` exit with the delivery that follows.

### The JS side

| file | responsibility |
|---|---|
| [`src/probes/probe.js`](src/probes/probe.js) | loads `bin/probe.bpf.o` once, binds the maps, starts the programs (they auto-attach) |
| [`src/probes/sigwire.js`](src/probes/sigwire.js) | the only BPF-aware data module: folds both ring buffers into a rolling feed with tallies, correlates delivery onto generation, owns the mute-mask knob — exposes the `feed`, `visible`, `muteMask` signals |
| [`src/main.jsx`](src/main.jsx) | composition root: input, selection, responsive layout (rail hides on narrow terminals), `mount` |
| [`src/components/feed.jsx`](src/components/feed.jsx) | the switchboard: `sender ──SIG──▶ target`, disposition/latency, badges, tint, coalescing |
| [`src/components/tally.jsx`](src/components/tally.jsx) | the side rail — top signals, breakdown by source, delivery tally |
| [`src/components/detail.jsx`](src/components/detail.jsx) | the inspector — per-signal disposition, handler, flags, blocked mask |
| [`src/components/picker.jsx`](src/components/picker.jsx) | the signal picker modal — mutes/shows each signal via the kernel mute mask |
| [`src/components/titlebar.jsx`](src/components/titlebar.jsx) | brand, live rate, totals, the `☠ fatal` counter, muted count, live/paused |
| [`src/components/footer.jsx`](src/components/footer.jsx) | key hints and the live filter prompt |
| [`src/lib/signals.js`](src/lib/signals.js) | the one source of truth: name, severity, colour, `si_code` → source, disposition, flags, mask decode, fatality |
| [`src/lib/format.js`](src/lib/format.js) | pure formatters — padding, truncation, `ago()`, durations, compact counts |
| [`src/lib/fuzzy.js`](src/lib/fuzzy.js) | subsequence fuzzy match over process + pid + signal + source + disposition |

The model is a rolling **feed of generated signals**, coalescing identical repeats into `×N` rows. A signal's generation row is frozen the instant its delivery resolves — so a row already on screen never changes or jumps. A 120 ms window timer publishes one snapshot per frame, so a busy ring buffer costs one re-render, not thousands.

### Why tracepoints, not `strace`/`ptrace`

`strace -f` follows one process tree and stops the tracee on every event; `ptrace` is per-target and intrusive. The signal tracepoints are the seam where the *kernel* raises and delivers a signal, for *every* process, with no per-app setup and no stopping anyone. Pairing generation ↔ delivery ↔ `rt_sigreturn` is what yields the sender/target pair, the disposition, per-handler latency, and the EINTR verdict that tie a signal's whole life together.

## Testing across kernels

`make veristat` loads `bin/probe.bpf.o` with veristat on **your** kernel — a quick check that every program passes the verifier, plus per-program complexity (insns/states). Loading BPF needs privileges, so use `sudo`.

A program that loads on your laptop can be rejected by an older kernel's verifier. [`.github/workflows/kernel-matrix.yml`](.github/workflows/kernel-matrix.yml) guards against that: for each kernel in its matrix it builds the object, boots that kernel in a VM ([cilium's little-vm-helper](https://github.com/cilium/little-vm-helper), images from `quay.io/lvh-images`), and runs the vendored static **veristat** against it — failing the job if the verifier rejects any program, and pivoting the per-kernel results into one ✅/❌ grid. The in-VM gate is [`build/verify-kernel.sh`](build/verify-kernel.sh).

Run the same matrix locally (Linux + KVM) with `make veristat-matrix` — it boots the kernel images with `lvh` + QEMU and prints an `ok`/`FAIL` grid. Pick kernels with `make veristat-matrix KERNELS="6.6 bpf-next"`.

## Requirements

> [!IMPORTANT]
> - **A Linux kernel with BTF** (`CONFIG_DEBUG_INFO_BTF`) for CO-RE — `bpftool` generates `src/bpf/include/vmlinux.h` from it. Default on current Arch, Fedora, Ubuntu, and Debian (every mainstream distro kernel since ~5.4).
> - **The yeet daemon**, which performs the privileged BPF load. The BPF capabilities are delegated to a daemonized process, so `sigwire` itself runs unprivileged. `curl -fsSL https://yeet.cx | sh` installs it.
>
> To build from source you also need `clang` and `bpftool` — but the vendored static toolchain supplies them, so you don't need a system C/BPF toolchain. No node/npm: esbuild is vendored too and the project has no third-party deps.

## Honest caveats

> [!NOTE]
> `sigwire` is observability, not enforcement. It shows you what was raised; it does not block, delay, or alter any signal.

- **A row is a *raised* signal.** The switchboard line comes from generation; the target may catch it, block it, or have already exited. The disposition/handler/mask columns come from the *delivery* side and fill in only once the kernel actually delivers it — a blocked or still-pending signal shows no disposition. See [What counts as fatal](#what-counts-as-fatal).
- **Correlation is best-effort.** Generation and delivery are separate tracepoints with no shared id, matched on `(target tid, signal)` within a time window. Under a storm of the same signal to the same thread the pairing can smear; it's right in the overwhelming common case.
- **Handler timing measures the kernel's frame, not your intent.** `ran` is delivery → `rt_sigreturn`. A handler that only sets a flag (CPython, Go's runtime) returns in microseconds even if the "real" work happens later in the event loop — accurate, just not what you might expect.
- **EINTR detection watches every syscall exit.** Catching interrupted syscalls means attaching to `raw_syscalls:sys_exit`, which fires on *every* syscall return system-wide (the handler bails immediately on all but the rare `-ERESTART*` codes, so the added cost is a couple of instructions per syscall — but it is not zero). Syscall *names* are an x86-64 table; other arches show the raw syscall number.
- **The sender of a kernel signal is `current`.** For a synchronous fault (`SIGSEGV` from a bad access) that's the faulting task itself — correct and useful. For an asynchronous kernel signal, `current` is whatever task was running when the kernel raised it, which is a hint, not gospel.
- **Real-time signal numbering is nominal.** `SIGRTMIN+n` is shown by raw offset; libraries reserve the low few for their own use.
- **`comm` is 16 bytes.** Long process names are truncated by the kernel, not by sigwire.

## Community questions

**Does it slow the traced processes down?**
No meaningful overhead. The tracepoint programs are passive; the cost is a bounded ring-buffer write per signal (and the couple of instructions per syscall exit for EINTR detection), and the ring buffer drops rather than blocks if userspace falls behind.

**Will it show signals aimed at a process that was already running when I start it?**
Yes. The tracepoints fire for every signal from the moment sigwire attaches, regardless of when the sender or target started — there's no per-process state to have missed.

**Does it work for any process, or just one?**
Any process on the host, all at once — the sender/target gutter tells them apart. It's the whole machine's signal traffic, not one pid.

**Can I export the feed?**
Not built in. The `RingBuf.subscribe` callbacks in `probes/sigwire.js` hold every decoded record, so a JSON/HTTP/Kafka sink is a branch there. To set up a managed pipeline, [contact us](https://yeet.cx/).

## Building from source

```sh
make          # clang + bpftool → bin/probe.bpf.o ; esbuild → src/index.jsx
make bpf      # just the BPF object
make bundle   # just the JS bundle
make clean    # remove build artifacts
```

Then `yeet run .` runs the local build. `make` runs two independent compilers: **clang + bpftool** link `src/bpf/*.bpf.c` into the loadable object `bin/probe.bpf.o`; **esbuild** bundles `src/main.jsx` into `src/index.jsx`, resolving the `@/` (source root) and `#/` (project root) **bundle-time aliases** via tsconfig `paths` and leaving `yeet:*` builtins external. Both compilers come from a vendored static toolchain, so the build needs no system C/BPF toolchain and no node/npm. The generated `vmlinux.h`, `src/index.jsx`, and `bin/*.bpf.o` are build artifacts.

Because the aliases are bundle-time only, the runtime locates the BPF object with `import.meta.dirname` rather than an alias. See [`AGENTS.md`](AGENTS.md) (aka `CLAUDE.md`) for the yeet dashboard-authoring guide.

## License

Dual BSD/GPL. The BPF program declares `char LICENSE[] SEC("license") = "Dual BSD/GPL"` in [`src/bpf/sigwire.bpf.c`](src/bpf/sigwire.bpf.c), which the kernel requires for the helpers it uses.

---

Built with [yeet](https://yeet.cx/docs/), a JS runtime for writing eBPF programs on Linux. Join us on [Discord](https://discord.gg/JxVseaAVAU).
