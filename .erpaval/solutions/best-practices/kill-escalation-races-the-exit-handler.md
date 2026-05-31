---
name: "Subprocess kill-escalation must not race its own exit handler for the settle reason"
description: When a supervisor times out a child, sends SIGTERM, then escalates to SIGKILL after a grace window, the child's 'exit' event and the SIGKILL-grace-timer both try to settle the Promise — and the exit handler usually wins with a less-accurate reason. Track a sigkillSent flag AND read the exit signal so the settled reason is honest regardless of which path fires first.
type: best-practices
---

A cobol-proleap subprocess supervisor (`superviseProcess`) timed out a
wedged JVM like this: on `timeoutMs` send SIGTERM; if no exit within
`killGraceMs`, send SIGKILL and settle with reason "...ignored SIGTERM
(SIGKILL sent)". A separate `child.on('exit')` handler also settled, with
the plainer reason "...timed out after Nms".

A unit test installed a SIGTERM-ignoring child to force the escalation
path and asserted the reason matched `/ignored SIGTERM \(SIGKILL sent\)/`.
It **flaked**: in the gate run the child's `exit` fired (the OS delivered a
signal despite the JS `SIGTERM` handler, or the handler raced its own
install), the exit handler settled FIRST with the plain reason, and the
SIGKILL-grace branch never got to run. Actual: `timed out after 150ms`.
Expected: the SIGKILL phrasing. Red gate.

## The shape of the bug

Two code paths can settle one Promise and they encode DIFFERENT reasons
for the same physical event:

```ts
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  killTimer = setTimeout(() => {
    child.kill("SIGKILL");
    settle({ reason: "...ignored SIGTERM (SIGKILL sent)" });   // path A
  }, killGraceMs);
}, timeoutMs);

child.on("exit", () => {
  if (timedOut) settle({ reason: "...timed out" });            // path B — usually wins
});
```

`settle()` is idempotent (first-wins), so correctness of the *reason*
depends on a RACE. Whichever fires first stamps the reason — and path B
(exit) almost always beats path A (a `killGraceMs` timer) because the child
often does die on SIGTERM.

## Fix: make the reason a function of state, not of which timer won

1. Track whether SIGKILL was sent (`let sigkillSent = false;` set in path A
   before `child.kill("SIGKILL")`).
2. Read the **exit signal** the OS reports: `child.on("exit", (code, signal) => …)`.
   `signal === "SIGKILL"` means the kill landed even if path B settles.
3. In the exit handler, derive the reason from state:
   `const killed = sigkillSent || signal === "SIGKILL";` then pick the
   SIGKILL phrasing when `killed`, the plain phrasing otherwise.

Now whichever path settles first, the reason is accurate. The test passed
3/3 in a row after the change (flaky tests need repeat-run confirmation,
not a single green).

## Generalizes to

Any supervise/watchdog/cancellation pattern where multiple async sources
(timeout timer, abort signal, child exit, stream error) feed one
idempotent settle and each carries its own status string. Don't let the
*winner of the race* author the outcome — compute the outcome from
accumulated state (flags + the OS-reported signal/code). Caught during the
2026-05-30 sweep's full-remediation gate; see
[[parallel-act-subagents-with-shared-git-tree]] for the surrounding
clean-rebuild discipline that made the flake reproducible.
