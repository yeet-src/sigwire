// The delivery side. signal_generate (sigwire.bpf.c) is the *sender's* view —
// who raised what. This unit is the *target's* view, which is the only place
// the answers to "did it catch it? how long did the handler run? what's it
// blocking? did it interrupt a syscall?" live:
//
//   signal:signal_deliver  fires in the target's context as it dequeues a
//                          signal to act on. It carries sa_handler (0 = default
//                          action, 1 = ignored, else the handler address ⇒
//                          caught) and sa_flags; `current` is the target, so we
//                          also read its blocked sigset straight off task_struct.
//
//   handler timing         a caught signal runs a userspace handler, which
//                          returns via rt_sigreturn(2). We stamp the delivery
//                          in a per-thread map and diff it at
//                          sys_enter_rt_sigreturn to get the handler's duration.
//
//   EINTR                  a signal that lands while a thread is blocked in a
//                          slow syscall interrupts it: the syscall exits with an
//                          internal -ERESTART* code (which carries the syscall
//                          number) *just before* the signal is delivered, and
//                          the kernel then either restarts it or returns -EINTR
//                          to userspace depending on the restart code and
//                          SA_RESTART. We stash the -ERESTART* at sys_exit and
//                          resolve it at signal_deliver — turning the classic
//                          "my read() randomly returned EINTR" gremlin visible.
//
// Everything feeds one ring buffer as `dispatch_event`s tagged with a phase;
// userspace correlates them back to the sender-side feed rows by (tid, signal).
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>

#define TASK_COMM_LEN 16
#define SA_RESTART 0x10000000

// Internal -ERESTART* return codes (include/linux/errno.h). A syscall exiting
// with one of these is being interrupted by a signal; -515 (ENOIOCTLCMD) sits
// in the range but never reaches this path.
#define ERESTARTSYS 512
#define ERESTART_RESTARTBLOCK 516

// Resolved EINTR verdict carried on a delivery event.
enum { INTR_NONE = 0, INTR_EINTR = 1, INTR_RESTARTED = 2 };

// Defined in sigwire.bpf.c; the linker merges the two units so this is the
// same live knob the UI patches. Muting a signal here keeps the delivery
// stream consistent with the (already-filtered) generation stream.
extern volatile __u64 mute_mask;

enum { PHASE_DELIVER = 0, PHASE_RETURN = 1 };

struct dispatch_event {
	__u32 pid; // target thread (tid) the signal is delivered to / handled by
	__u32 tgid;
	__s32 sig;
	__s32 code;
	__u32 phase; // PHASE_DELIVER | PHASE_RETURN
	__u32 eintr; // INTR_NONE | INTR_EINTR | INTR_RESTARTED (PHASE_DELIVER)
	__s32 intr_syscall; // interrupted syscall nr, or -1 (PHASE_DELIVER)
	__u32 _pad;
	__u64 handler; // sa_handler: 0 = SIG_DFL, 1 = SIG_IGN, else handler addr
	__u64 sa_flags;
	__u64 blocked; // target->blocked sigset (signals 1..64) — what it's masking
	__u64 dur_ns; // handler wall duration (PHASE_RETURN)
	__u64 ts_ns;
	char comm[TASK_COMM_LEN];
};

struct dispatch_event *_unused_dispatch __attribute__((unused));

// Per-thread handler-start stamp: set when a caught signal is delivered,
// consumed at rt_sigreturn. Keyed by tid.
struct pending {
	__u64 ts;
	__s32 sig;
	__s32 code;
};

// Per-thread "a syscall just returned an -ERESTART* code" stamp, set at
// sys_exit and resolved at the signal_deliver that immediately follows.
struct restart {
	__u64 ts;
	__s32 syscall;
	__s32 code; // the -ERESTART* value (negative)
};

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);
} dispatch SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, __u32);
	__type(value, struct pending);
} handler_start SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, __u32);
	__type(value, struct restart);
} restart_pending SEC(".maps");

// Mirror of the kernel's restart decision (arch handle_signal): -ERESTARTNOHAND
// and -ERESTART_RESTARTBLOCK always become EINTR once a handler runs;
// -ERESTARTSYS becomes EINTR unless SA_RESTART; -ERESTARTNOINTR always restarts.
static __u32 classify_intr(__s32 code, __u64 sa_flags)
{
	switch (code) {
	case -514: // ERESTARTNOHAND
	case -516: // ERESTART_RESTARTBLOCK
		return INTR_EINTR;
	case -513: // ERESTARTNOINTR
		return INTR_RESTARTED;
	case -512: // ERESTARTSYS
		return (sa_flags & SA_RESTART) ? INTR_RESTARTED : INTR_EINTR;
	default:
		return INTR_NONE;
	}
}

// Fires on every syscall exit; almost all return immediately. Only the rare
// -ERESTART* codes (a syscall being torn out by a pending signal) are recorded,
// for the very next signal_deliver on this thread to pick up.
SEC("tracepoint/raw_syscalls/sys_exit")
int on_sys_exit(struct trace_event_raw_sys_exit *ctx)
{
	long ret = ctx->ret;
	if (ret > -ERESTARTSYS || ret < -ERESTART_RESTARTBLOCK) {
		return 0;
	}
	__u32 tid = (__u32)bpf_get_current_pid_tgid();
	struct restart r = { .ts = bpf_ktime_get_ns(), .syscall = (__s32)ctx->id, .code = (__s32)ret };
	bpf_map_update_elem(&restart_pending, &tid, &r, BPF_ANY);
	return 0;
}

SEC("tracepoint/signal/signal_deliver")
int on_signal_deliver(struct trace_event_raw_signal_deliver *ctx)
{
	__s32 sig = ctx->sig;
	if (sig >= 0 && sig < 64 && (mute_mask & (1ULL << sig))) {
		return 0;
	}

	__u64 id = bpf_get_current_pid_tgid();
	__u32 tid = (__u32)id;
	__u64 now = bpf_ktime_get_ns();
	__u64 handler = ctx->sa_handler;

	// Did this delivery interrupt a blocked syscall? Resolve the -ERESTART*
	// stashed microseconds ago at sys_exit into an EINTR / restarted verdict.
	// EINTR only reaches userspace when a handler actually runs (handler > 1):
	// an unhandled signal either kills the task, is ignored, or stops it — the
	// syscall never returns EINTR — so only caught signals are classified.
	__u32 eintr = INTR_NONE;
	__s32 intr_syscall = -1;
	struct restart *r = bpf_map_lookup_elem(&restart_pending, &tid);
	if (r) {
		if (handler > 1 && now - r->ts < 50000000ULL) { // caught + fresh (50ms)
			eintr = classify_intr(r->code, ctx->sa_flags);
			intr_syscall = r->syscall;
		}
		bpf_map_delete_elem(&restart_pending, &tid);
	}

	struct dispatch_event *e = bpf_ringbuf_reserve(&dispatch, sizeof(*e), 0);
	if (e) {
		e->pid = tid;
		e->tgid = id >> 32;
		e->sig = sig;
		e->code = ctx->code;
		e->phase = PHASE_DELIVER;
		e->eintr = eintr;
		e->intr_syscall = intr_syscall;
		e->_pad = 0;
		e->handler = handler;
		e->sa_flags = ctx->sa_flags;
		e->blocked = BPF_CORE_READ((struct task_struct *)bpf_get_current_task(), blocked.sig[0]);
		e->dur_ns = 0;
		e->ts_ns = now;
		bpf_get_current_comm(&e->comm, sizeof(e->comm));
		bpf_ringbuf_submit(e, 0);
	}

	// Only caught signals (real handler address) run a handler that returns
	// via rt_sigreturn — stamp those for timing.
	if (handler > 1) {
		struct pending p = { .ts = now, .sig = sig, .code = ctx->code };
		bpf_map_update_elem(&handler_start, &tid, &p, BPF_ANY);
	}
	return 0;
}

SEC("tracepoint/syscalls/sys_enter_rt_sigreturn")
int on_rt_sigreturn(void *ctx)
{
	__u32 tid = (__u32)bpf_get_current_pid_tgid();
	struct pending *p = bpf_map_lookup_elem(&handler_start, &tid);
	if (!p) {
		return 0;
	}

	__u64 now = bpf_ktime_get_ns();
	struct dispatch_event *e = bpf_ringbuf_reserve(&dispatch, sizeof(*e), 0);
	if (e) {
		e->pid = tid;
		e->tgid = bpf_get_current_pid_tgid() >> 32;
		e->sig = p->sig;
		e->code = p->code;
		e->phase = PHASE_RETURN;
		e->eintr = INTR_NONE;
		e->intr_syscall = -1;
		e->_pad = 0;
		e->handler = 0;
		e->sa_flags = 0;
		e->blocked = 0;
		e->dur_ns = now - p->ts;
		e->ts_ns = now;
		bpf_get_current_comm(&e->comm, sizeof(e->comm));
		bpf_ringbuf_submit(e, 0);
	}
	bpf_map_delete_elem(&handler_start, &tid);
	return 0;
}
