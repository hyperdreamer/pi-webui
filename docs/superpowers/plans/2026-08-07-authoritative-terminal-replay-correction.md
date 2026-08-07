# Authoritative Terminal Replay Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal reconnect recovery authoritative by resetting the existing xterm before applying the daemon's retained replay buffer.

**Architecture:** Keep the existing websocket protocol, server replay buffer, and reconnect controller unchanged. Treat each `replay: true` terminal output message as a complete retained snapshot for the pane: perform xterm's full RIS reset before the replay write, while preserving write ordering and suppressing terminal input until xterm finishes processing the replay.

**Tech Stack:** TypeScript, Lit, `@xterm/xterm`, Vitest fake timers, existing terminal websocket APIs.

## Global Constraints

- This plan is the corrective continuation for `F-4` from `.superpowers/sdd/2026-08-07-websocket-slow-consumer-backpressure/final-rereviewer-report.md` after that run legally reached `FINAL_BLOCKED`; do not reopen or edit the old run's canonical state.
- `replay: true` is authoritative pane state, not incremental output. Call `Terminal.reset()` before `Terminal.write()` so retained output replaces the existing emulator state instead of appending to it.
- Preserve ordinary `replay: false` output as an ordered append with no reset.
- Preserve the 500 ms to 5 s, x1.6 reconnect backoff, reset-on-open, stale timer checks, exit suppression, synchronous-close disposal behavior, resize behavior, and message ordering.
- Preserve `suppressTerminalInput`: set it before replay reset/write and clear it only from the replay write callback.
- No protocol, server, replay-buffer, public API, dependency, or production-default changes.
- Modify only `src/client/src/components/TerminalPanel.ts` and `src/client/src/components/TerminalPanel.reconnect.test.ts` for the implementation commit.
- Follow `.agents/skills/code-quality-architecture/SKILL.md`, `.agents/skills/testing-guide/SKILL.md`, `/home/henry/.pi/agent/skills/test-driven-development/SKILL.md`, and `/home/henry/.pi/agent/pi-hermes-memory/skills/verify-red-phase-is-falsifiable/SKILL.md`.
- Use TDD, record the expected RED failure, mutation-prove the replay-reset regression, run the focused and component suites, and run `npm run verify` before commit.
- Keep `.changeset/websocket-slow-consumer-backpressure.md` unchanged; it already covers automatic terminal recovery in this unreleased branch. Do not edit `CHANGELOG.md` or add a duplicate Changeset.
- The corrective commit is client-only, but the complete websocket branch still requires a manual `pi-webui-sessiond` restart because earlier commits changed `SessionEventHub`.

## Task 1: Reset xterm before authoritative replay

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/TerminalPanel.ts:374-400`
- Modify: `src/client/src/components/TerminalPanel.reconnect.test.ts:13-173`

**Interfaces:**

- Consumes: the existing private `connectSocket(projectId: string, workspaceId: string, terminalId: string, terminal: Terminal, initialSize: TerminalSize | undefined): void` and `writeTerminalOutput(terminal: Terminal, data: string, replay: boolean): void` methods.
- Consumes: xterm's existing `Terminal.reset(): void`, which performs a full RIS, and `Terminal.write(data: string | Uint8Array, callback?: () => void): void`.
- Produces: no new exports or protocol fields. For `replay: true`, `writeTerminalOutput` must set input suppression, call `terminal.reset()`, then call `terminal.write(data, callback)`; for `replay: false`, it must continue to call only `terminal.write(data)`.

- [ ] **Step 1: Read the finding and current reconnect path**

Read these files completely before editing:

- `.superpowers/sdd/2026-08-07-websocket-slow-consumer-backpressure/final-rereviewer-report.md`
- `src/client/src/components/TerminalPanel.ts`
- `src/client/src/components/TerminalPanel.reconnect.test.ts`
- `src/server/terminals/terminalService.ts:1-140`
- `node_modules/@xterm/xterm/typings/xterm.d.ts:1260-1300`

Confirm the root cause in the current code: reconnect reuses the same `Terminal`, `TerminalService.attach()` sends its retained buffer with `replay: true`, and the replay branch writes without a reset.

- [ ] **Step 2: Add the failing reconnect replay regression**

In `TerminalPanel.reconnect.test.ts`, expand the terminal fake to expose typed `reset`, `write`, and `writeln` methods. Let an optional event list record reset/write order and invoke the write callback synchronously:

```ts
type FakeTerminal = Pick<Terminal, "reset" | "write" | "writeln">;

function fakeTerminal(events: string[] = []): FakeTerminal {
  return {
    reset: vi.fn(() => { events.push("reset"); }),
    write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
      events.push(`write:${typeof data === "string" ? data : "<bytes>"}`);
      callback?.();
    }),
    writeln: vi.fn(),
  };
}
```

Update the local `connectSocket` helper to accept `FakeTerminal`. Add this test beside the other reconnect cases:

```ts
it("resets the terminal before applying replay after a reconnect", async () => {
  const firstSocket = new FakeTerminalSocket();
  const secondSocket = new FakeTerminalSocket();
  terminalSocketMock
    .mockReturnValueOnce(asWebSocket(firstSocket))
    .mockReturnValueOnce(asWebSocket(secondSocket));
  const panel = new TerminalPanel();
  const events: string[] = [];
  const terminal = fakeTerminal(events);

  connectSocket(panel, terminal);
  firstSocket.emit("message", {
    data: JSON.stringify({ type: "output", data: "live", replay: false }),
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(["write:live"]);

  firstSocket.emit("close");
  vi.advanceTimersByTime(500);
  expect(terminalSocketMock).toHaveBeenCalledTimes(2);

  secondSocket.emit("message", {
    data: JSON.stringify({ type: "output", data: "snapshot", replay: true }),
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(events).toEqual(["write:live", "reset", "write:snapshot"]);
  expect(Reflect.get(panel, "suppressTerminalInput")).toBe(false);
});
```

This assertion proves live output remains append-only and replay resets the reused terminal before its authoritative write. Do not replace it with an assertion only about factory calls or reconnect timing.

- [ ] **Step 3: Run the focused test and confirm RED**

Run:

```bash
npm test -- --run src/client/src/components/TerminalPanel.reconnect.test.ts
```

Expected: the new test fails while the existing five reconnect/disposal/exit tests pass. The event list should omit `reset`, receiving `["write:live", "write:snapshot"]` instead of `["write:live", "reset", "write:snapshot"]`.

If the new test passes before production changes or fails for a different reason, stop and correct the test before implementation.

- [ ] **Step 4: Implement the minimal replay reset**

Change only the replay branch in `writeTerminalOutput`:

```ts
private writeTerminalOutput(terminal: Terminal, data: string, replay: boolean): void {
  if (!replay) {
    terminal.write(data);
    return;
  }
  this.suppressTerminalInput = true;
  terminal.reset();
  terminal.write(data, () => {
    this.suppressTerminalInput = false;
  });
}
```

Do not reset for live output, recreate the terminal, change the websocket message schema, or change reconnect scheduling.

- [ ] **Step 5: Confirm focused GREEN and component compatibility**

Run:

```bash
npm test -- --run src/client/src/components/TerminalPanel.reconnect.test.ts
npm test -- --run src/client/src/components
```

Expected: six reconnect tests pass, then the complete component suite passes.

- [ ] **Step 6: Mutation-prove the regression**

Back up the fixed source to a temporary file. Remove only `terminal.reset()` from the replay branch and rerun:

```bash
npm test -- --run src/client/src/components/TerminalPanel.reconnect.test.ts
```

Expected: only the authoritative replay test fails with the event-order mismatch; the other five tests pass. Restore the source without a destructive Git command, prove it is byte-identical to the backup with SHA-256, delete the temporary backup, and rerun the focused suite to six passing tests.

- [ ] **Step 7: Run static and full verification**

Run sequentially on an otherwise idle machine:

```bash
npx eslint src/client/src/components/TerminalPanel.ts src/client/src/components/TerminalPanel.reconnect.test.ts
npm run typecheck
git diff --check
npm run verify
```

If the full suite reports a timeout, follow `.agents/skills/testing-guide/SKILL.md`: rerun the failing file alone before classifying it, and do not raise a timeout merely to hide machine contention.

- [ ] **Step 8: Inspect and commit only the corrective files**

Inspect `git status --porcelain`, the unstaged diff, and the staged diff. Stage only:

```bash
git add src/client/src/components/TerminalPanel.ts src/client/src/components/TerminalPanel.reconnect.test.ts
git diff --cached --check
git commit -m "fix(client): reset terminal before replay"
```

The final report must include the RED/GREEN counts, event-order failure, mutation/restoration evidence, component/full verification counts, exact changed files, commit SHA, clean worktree status, unchanged Changeset, and the whole-branch manual session-daemon restart reminder.
