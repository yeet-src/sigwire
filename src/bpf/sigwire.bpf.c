// sigwire — stream every signal the kernel *generates* for a task, tagged
// with who sent it, who it's aimed at, and how the kernel handled it.
//
// The `signal:signal_generate` tracepoint fires in the SENDER's context at
// the moment a signal is raised for a target, before delivery. The target
// (comm + pid) and the signal metadata (number, si_code, result) come off
// the tracepoint record; the sender is simply `current`. That pairing —
// current → target — is the whole "switchboard": who is signalling whom.
//
// The runtime knob `mute_mask` is the two-way half: userspace patches it
// (via DataSec) and the kernel drops any signal whose number is set in the
// mask *before* it ever reaches the ring buffer — a filter you can't do in
// JS, since JS only sees the events the kernel chose to emit.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>

#define TASK_COMM_LEN 16

char LICENSE[] SEC("license") = "Dual BSD/GPL";

// Bitmask of signal numbers to drop in-kernel (bit N ⇒ signal N is muted).
// The default mutes the high-rate housekeeping signals — SIGCHLD (17),
// SIGURG (23), SIGWINCH (28) — so the feed is the interesting traffic; the
// signal picker flips individual bits live (DataSec.patch) to mute or show
// each one. Non-zero keeps it in .data (not .bss), so the bound section stays
// `<obj>.data`. Must match DEFAULT_MUTE's initial value in probes/sigwire.js.
volatile __u64 mute_mask = (1ULL << 17) | (1ULL << 23) | (1ULL << 28);

// One generated signal, streamed to userspace. sender_* is `current` (who
// raised it); target_* is who it's aimed at; code is the si_code (SI_USER,
// SI_KERNEL, SI_TKILL, …), group is 1 for a whole-process signal, and result
// is the kernel's TRACE_SIGNAL_* disposition (delivered / ignored / …).
struct signal_event {
	__u32 sender_tgid;
	__u32 sender_pid;
	__u32 target_pid;
	__s32 sig;
	__s32 code;
	__s32 result;
	__s32 group;
	__u64 ts_ns;
	char sender_comm[TASK_COMM_LEN];
	char target_comm[TASK_COMM_LEN];
};

// Force BTF emission of signal_event so the daemon can resolve
// btf_struct: "signal_event" on the ring buffer.
struct signal_event *_unused_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);
} events SEC(".maps");

SEC("tracepoint/signal/signal_generate")
int on_signal_generate(struct trace_event_raw_signal_generate *ctx)
{
	__s32 sig = ctx->sig;

	// Drop muted signals in-kernel — the live knob. Bound the shift so the
	// verifier is happy and real-time signals (>63) are never masked.
	if (sig >= 0 && sig < 64 && (mute_mask & (1ULL << sig))) {
		return 0;
	}

	struct signal_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		return 0; // ring full — dropping is the backpressure
	}

	__u64 id = bpf_get_current_pid_tgid();
	e->sender_tgid = id >> 32;
	e->sender_pid = (__u32)id;
	e->target_pid = ctx->pid;
	e->sig = sig;
	e->code = ctx->code;
	e->result = ctx->result;
	e->group = ctx->group;
	e->ts_ns = bpf_ktime_get_ns();
	bpf_get_current_comm(&e->sender_comm, sizeof(e->sender_comm));
	bpf_probe_read_kernel_str(&e->target_comm, sizeof(e->target_comm), ctx->comm);
	bpf_ringbuf_submit(e, 0);
	return 0;
}
