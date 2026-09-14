import { describe, expect, it, vi } from "vitest";
import { MODEL_RATE_LIMITS_BLOCKED_CODE, createModelRateLimitOwner } from "./modelRateLimitOwner";
import {
  createControllableStream,
  createFakeModelRateLimitClock,
  deferred,
  fixtureIdentity,
  fixtureLimits,
  fixtureSnapshot,
  fixtureTerminalMessage,
} from "./modelRateLimit.testSupport";

const demo = fixtureIdentity("acme", "demo-model");
const sibling = fixtureIdentity("acme", "sibling-model");

type LimitMap = Record<string, Record<string, { tpm?: number; rpm?: number }>>;

function createOwner(limits: LimitMap = {}) {
  const clock = createFakeModelRateLimitClock();
  const rateLimits = createModelRateLimitOwner({ clock });
  rateLimits.applySnapshot(fixtureSnapshot(limits), "accepted-document");
  return { clock, rateLimits };
}

describe("model rate limit owner", () => {
  it("admits immediately when both dimensions are disabled", async () => {
    const { clock, rateLimits } = createOwner();

    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });

    expect(rateLimits.pendingWaiterCount(demo)).toBe(0);
    expect(rateLimits.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("admits exactly rpm requests and queues the next request until the window expires", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 2) } });

    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });
    const queued = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    clock.advance(59_999);
    await Promise.resolve();
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    clock.advance(1);
    await expect(queued).resolves.toEqual({ status: "granted" });
  });

  it("uses strict inequality for tpm and ignores totalTokens", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(10) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 9, totalTokens: 100_000 });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });
    rateLimits.completeCall(demo, { input: 1 });
    const queued = rateLimits.acquire(demo);

    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("sums all four terminal counters", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(10) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    const queued = rateLimits.acquire(demo);

    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("expires request and token entries independently", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(10, 1) } });

    await rateLimits.acquire(demo);
    clock.advance(30_000);
    rateLimits.completeCall(demo, { input: 10 });
    const queued = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    clock.advance(30_000);
    await Promise.resolve();
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    clock.advance(30_000);
    await expect(queued).resolves.toEqual({ status: "granted" });
  });

  it("allows an admitted call and concurrent in-flight calls to overshoot tpm", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 500 });
    const afterOvershoot = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.dispose();
    await expect(afterOvershoot).resolves.toEqual({ status: "aborted" });

    const concurrent = createOwner({ acme: { "demo-model": fixtureLimits(1) } });
    await concurrent.rateLimits.acquire(demo);
    await concurrent.rateLimits.acquire(demo);
    concurrent.rateLimits.completeCall(demo, { input: 50 });
    concurrent.rateLimits.completeCall(demo, { input: 50 });
    const third = concurrent.rateLimits.acquire(demo);
    expect(concurrent.rateLimits.pendingWaiterCount(demo)).toBe(1);
    concurrent.rateLimits.dispose();
    await expect(third).resolves.toEqual({ status: "aborted" });
  });

  it("keeps disabled dimensions independent", async () => {
    const tpmOnly = createOwner({ acme: { "demo-model": fixtureLimits(5) } });
    await tpmOnly.rateLimits.acquire(demo);
    tpmOnly.rateLimits.completeCall(demo, { output: 5 });
    const blocked = tpmOnly.rateLimits.acquire(demo);
    expect(tpmOnly.rateLimits.pendingWaiterCount(demo)).toBe(1);
    tpmOnly.rateLimits.dispose();
    await expect(blocked).resolves.toEqual({ status: "aborted" });

    const prmOnly = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 5) } });
    for (let index = 0; index < 5; index += 1) await prmOnly.rateLimits.acquire(demo);
    prmOnly.rateLimits.completeCall(demo, { input: 1_000_000 });
    const sixth = prmOnly.rateLimits.acquire(demo);
    expect(prmOnly.rateLimits.pendingWaiterCount(demo)).toBe(1);
    prmOnly.rateLimits.dispose();
    await expect(sixth).resolves.toEqual({ status: "aborted" });
  });

  it("grants queued waiters in FIFO order", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1, 10) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 1 });
    const order: string[] = [];
    const second = rateLimits.acquire(demo).then(() => { order.push("second"); });
    const third = rateLimits.acquire(demo).then(() => { order.push("third"); });
    expect(rateLimits.pendingWaiterCount(demo)).toBe(2);

    clock.advance(60_000);
    await Promise.all([second, third]);

    expect(order).toEqual(["second", "third"]);
  });

  it("does not starve the next waiter when the head is cancelled", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 1) } });

    await rateLimits.acquire(demo);
    const controller = new AbortController();
    const cancelled = rateLimits.acquire(demo, controller.signal);
    const next = rateLimits.acquire(demo);
    controller.abort();

    await expect(cancelled).resolves.toEqual({ status: "aborted" });
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    clock.advance(60_000);
    await expect(next).resolves.toEqual({ status: "granted" });
  });

  it("leaves other models unblocked", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1), "sibling-model": fixtureLimits(1) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 1 });
    await expect(rateLimits.acquire(sibling)).resolves.toEqual({ status: "granted" });
  });

  it("wakes eligible waiters when a limit is raised or disabled and keeps them waiting when lowered", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(100) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 100 });
    const raised = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.applySnapshot(fixtureSnapshot({ acme: { "demo-model": fixtureLimits(150) } }), "accepted-document");
    await expect(raised).resolves.toEqual({ status: "granted" });

    rateLimits.completeCall(demo, { input: 50 });
    const disabled = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.applySnapshot(fixtureSnapshot({}), "accepted-document");
    await expect(disabled).resolves.toEqual({ status: "granted" });

    const lowered = createOwner({ acme: { "demo-model": fixtureLimits(100) } });
    await lowered.rateLimits.acquire(demo);
    lowered.rateLimits.completeCall(demo, { input: 100 });
    const queued = lowered.rateLimits.acquire(demo);
    lowered.rateLimits.applySnapshot(fixtureSnapshot({ acme: { "demo-model": fixtureLimits(10) } }), "accepted-document");
    expect(lowered.rateLimits.pendingWaiterCount(demo)).toBe(1);
    lowered.rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("retains recent usage across snapshot publication", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(10) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 10 });
    rateLimits.applySnapshot(fixtureSnapshot({ acme: { "demo-model": fixtureLimits(10, 4) } }), "accepted-document");
    const queued = rateLimits.acquire(demo);

    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("removes the restriction without cancelling work when an identity leaves the snapshot", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1), "sibling-model": fixtureLimits(1) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 1 });
    const queued = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    rateLimits.applySnapshot(fixtureSnapshot({ acme: { "sibling-model": fixtureLimits(1) } }), "accepted-document");
    await expect(queued).resolves.toEqual({ status: "granted" });
    expect(rateLimits.pendingWaiterCount(sibling)).toBe(0);
  });

  it("retains RPM-only history when an identity leaves and re-enters the snapshot", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 1) } });

    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });
    rateLimits.completeCall(demo, undefined);
    expect(rateLimits.activeIdentityCount()).toBe(1);

    rateLimits.applySnapshot(fixtureSnapshot({}), "accepted-document");
    expect(rateLimits.activeIdentityCount()).toBe(1);

    rateLimits.applySnapshot(fixtureSnapshot({ acme: { "demo-model": fixtureLimits(undefined, 1) } }), "accepted-document");
    const queued = rateLimits.acquire(demo);

    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("keeps at most one timer per blocked identity and clears it after draining", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 1) } });

    await rateLimits.acquire(demo);
    const first = rateLimits.acquire(demo);
    const second = rateLimits.acquire(demo);
    expect(rateLimits.activeTimerCount()).toBe(1);
    expect(clock.pendingTimerCount()).toBe(1);

    clock.advance(60_000);
    await expect(first).resolves.toEqual({ status: "granted" });
    expect(rateLimits.activeTimerCount()).toBe(1);
    expect(clock.pendingTimerCount()).toBe(1);

    rateLimits.dispose();
    await expect(second).resolves.toEqual({ status: "aborted" });
    expect(rateLimits.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("releases in-flight counts on completion and retains request history until the window expires", async () => {
    const { clock, rateLimits } = createOwner();

    await rateLimits.acquire(demo);
    expect(rateLimits.inFlightCount(demo)).toBe(1);
    expect(rateLimits.activeIdentityCount()).toBe(1);

    rateLimits.completeCall(demo, undefined);
    expect(rateLimits.inFlightCount(demo)).toBe(0);
    expect(rateLimits.activeIdentityCount()).toBe(1);

    clock.advance(60_000);
    rateLimits.completeCall(demo, undefined);
    expect(rateLimits.activeIdentityCount()).toBe(0);
  });

  it("keeps states with waiters, history, or configured limits", async () => {
    const withLimits = createOwner({ acme: { "demo-model": fixtureLimits(10) } });
    expect(withLimits.rateLimits.activeIdentityCount()).toBe(1);

    await withLimits.rateLimits.acquire(demo);
    withLimits.rateLimits.completeCall(demo, { input: 10 });
    expect(withLimits.rateLimits.activeIdentityCount()).toBe(1);

    const queued = withLimits.rateLimits.acquire(demo);
    expect(withLimits.rateLimits.pendingWaiterCount(demo)).toBe(1);
    expect(withLimits.rateLimits.activeIdentityCount()).toBe(1);
    withLimits.rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("returns a structured blocked admission without queueing when no snapshot was accepted", async () => {
    const clock = createFakeModelRateLimitClock();
    const rateLimits = createModelRateLimitOwner({ clock });
    rateLimits.reportLoadFailure("models.json could not be parsed: bad");

    expect(rateLimits.readStatus()).toEqual({ revision: 0, admission: "blocked", source: "none", error: "models.json could not be parsed: bad" });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({
      status: "blocked",
      code: MODEL_RATE_LIMITS_BLOCKED_CODE,
      error: "models.json could not be parsed: bad",
    });
    expect(rateLimits.pendingWaiterCount(demo)).toBe(0);
    expect(rateLimits.activeTimerCount()).toBe(0);
  });

  it("keeps last-known-good limits after a later load failure", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1) } });

    rateLimits.reportLoadFailure("models.json could not be parsed: bad");

    expect(rateLimits.readStatus()).toEqual({ revision: 1, admission: "ready", source: "last-known-good", error: "models.json could not be parsed: bad" });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });
  });

  it("rejects an already-aborted acquire without creating state", async () => {
    const { rateLimits } = createOwner();
    const controller = new AbortController();
    controller.abort();

    await expect(rateLimits.acquire(demo, controller.signal)).resolves.toEqual({ status: "aborted" });
    expect(rateLimits.activeIdentityCount()).toBe(0);
  });

  it("settles waiters and clears timers on dispose and stops accepting work", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 1) } });

    await rateLimits.acquire(demo);
    const queued = rateLimits.acquire(demo);
    expect(clock.pendingTimerCount()).toBe(1);

    rateLimits.dispose();

    await expect(queued).resolves.toEqual({ status: "aborted" });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "aborted" });
    expect(rateLimits.pendingWaiterCount(demo)).toBe(0);
    expect(rateLimits.activeTimerCount()).toBe(0);
    expect(rateLimits.activeIdentityCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
    rateLimits.completeCall(demo, { input: 1 });
    expect(rateLimits.inFlightCount(demo)).toBe(0);
  });

  it("logs one queue warning per transition and one warning per blocked admission", async () => {
    const warn = vi.fn();
    const clock = createFakeModelRateLimitClock();
    const rateLimits = createModelRateLimitOwner({ clock, logger: { warn } });
    rateLimits.applySnapshot(fixtureSnapshot({ acme: { "demo-model": fixtureLimits(undefined, 1) } }), "accepted-document");

    await rateLimits.acquire(demo);
    const first = rateLimits.acquire(demo);
    const second = rateLimits.acquire(demo);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ provider: "acme", modelId: "demo-model", dimension: "rpm" });

    rateLimits.dispose();
    await expect(first).resolves.toEqual({ status: "aborted" });
    await expect(second).resolves.toEqual({ status: "aborted" });

    const blockedWarn = vi.fn();
    const blocked = createModelRateLimitOwner({ clock: createFakeModelRateLimitClock(), logger: { warn: blockedWarn } });
    blocked.reportLoadFailure("bad file");
    await blocked.acquire(demo);
    expect(blockedWarn).toHaveBeenCalledTimes(1);
  });
});

describe("model rate limit test support", () => {
  it("fixtureTerminalMessage returns a terminal assistant message with zero usage", () => {
    const message = fixtureTerminalMessage();

    expect(message.role).toBe("assistant");
    expect(message.stopReason).toBe("stop");
    expect(message.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
  });

  it("createControllableStream forwards events and settles the terminal result", async () => {
    const controllable = createControllableStream();
    const message = fixtureTerminalMessage();
    const received: string[] = [];

    const consumed = (async () => {
      for await (const event of controllable.stream) received.push(event.type);
    })();
    controllable.push({ type: "start", partial: message });
    controllable.end(message);
    await consumed;

    expect(received).toEqual(["start", "done"]);
    await expect(controllable.stream.result()).resolves.toBe(message);
  });

  it("deferred settles its promise under test control", async () => {
    const resolved = deferred<number>();
    resolved.resolve(7);
    await expect(resolved.promise).resolves.toBe(7);

    const rejected = deferred<number>();
    rejected.reject(new Error("nope"));
    await expect(rejected.promise).rejects.toThrow("nope");
  });
});
