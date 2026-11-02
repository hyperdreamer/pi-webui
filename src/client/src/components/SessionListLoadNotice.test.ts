// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Machine } from "../api";
import type { SessionListFailure, SessionListLoad } from "../appState";
import { SESSION_LIST_NOTICE_DELAY_MS, SESSION_LIST_NOTICE_TICK_MS, SessionListLoadNotice } from "./SessionListLoadNotice";

// The wait and its failure are described relative to this start, so the elapsed
// values in the assertions read like the timestamps that produced them.
const LOAD_STARTED_AT = 1_000_000;
const REMOTE_BUDGET_MS = 120_000;

const remoteMachine: Machine = {
  id: "remote",
  name: "Remote Lab",
  kind: "remote",
  baseUrl: "https://remote.example",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

const localMachine: Machine = {
  id: "local",
  name: "This machine",
  kind: "local",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("session list load notice", () => {
  it("shows a human remote wait at five seconds and updates once per second", async () => {
    const clock = fakeClock(LOAD_STARTED_AT);
    const notice = await renderNotice((element) => {
      element.machine = remoteMachine;
      element.load = selectionLoad();
      element.now = clock.now;
    });

    expect(noticeText(notice)).toBe("");
    expect(activeIntervals()).toBe(1);

    clock.advance(SESSION_LIST_NOTICE_DELAY_MS - 1);
    await vi.advanceTimersByTimeAsync(SESSION_LIST_NOTICE_DELAY_MS - 1);
    expect(noticeText(notice)).toBe("");

    clock.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    await notice.updateComplete;
    expect(statusRegion(notice)?.textContent).toContain("Loading sessions from Remote Lab… 0:05 of 2:00");

    clock.advance(SESSION_LIST_NOTICE_TICK_MS);
    await vi.advanceTimersByTimeAsync(SESSION_LIST_NOTICE_TICK_MS);
    await notice.updateComplete;
    expect(noticeText(notice)).toContain("Loading sessions from Remote Lab… 0:06 of 2:00");
    expect(activeIntervals()).toBe(1);
  });

  it("renders nothing for a local machine, a catalog fallback read, or a mismatched scope", async () => {
    expect(await renderedText(remoteMachine, localSelectionLoad(), undefined)).toBe("");
    expect(await renderedText(remoteMachine, selectionLoad({ owner: "catalog-fallback" }), undefined)).toBe("");
    expect(await renderedText(remoteMachine, selectionLoad({ machineId: "/other" }), undefined)).toBe("");
    expect(await renderedText(localMachine, selectionLoad(), undefined)).toBe("");
    expect(activeIntervals()).toBe(0);
  });

  it("renders retry-owned progress while a catalog fallback read owns no clock", async () => {
    const clock = fakeClock(LOAD_STARTED_AT);
    const retry = await renderNotice((element) => {
      element.machine = remoteMachine;
      element.load = selectionLoad({ owner: "retry" });
      element.now = clock.now;
    });

    expect(noticeText(retry)).toBe("");
    clock.advance(SESSION_LIST_NOTICE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(SESSION_LIST_NOTICE_DELAY_MS);
    await retry.updateComplete;
    expect(statusRegion(retry)?.textContent).toContain("Loading sessions from Remote Lab… 0:05 of 2:00");
    retry.remove();
    expect(activeIntervals()).toBe(0);

    const fallback = await renderNotice((element) => {
      element.machine = remoteMachine;
      element.load = selectionLoad({ owner: "catalog-fallback" });
      element.now = clock.now;
    });
    clock.advance(SESSION_LIST_NOTICE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(SESSION_LIST_NOTICE_DELAY_MS);
    await fallback.updateComplete;
    expect(noticeText(fallback)).toBe("");
    expect(activeIntervals()).toBe(0);
  });

  it("shows receiving before any body byte without a budget countdown", async () => {
    const clock = fakeClock(LOAD_STARTED_AT);
    const notice = await renderNotice((element) => {
      element.machine = remoteMachine;
      element.load = selectionLoad({ phase: "receiving" });
      element.now = clock.now;
    });

    expect(statusRegion(notice)?.textContent).toBe("Receiving sessions from Remote Lab…");
    expect(activeIntervals()).toBe(0);

    clock.advance(200_000);
    await vi.advanceTimersByTimeAsync(200_000);
    await notice.updateComplete;
    expect(noticeText(notice)).not.toContain("of");

    notice.failure = timeoutFailure(1_200_000);
    await notice.updateComplete;
    expect(activeIntervals()).toBe(0);
  });

  it("renders both typed failures with elapsed and the two scoped actions", async () => {
    const retry = vi.fn();
    const raise = vi.fn();
    const timeout = await renderNotice((element) => {
      element.machine = remoteMachine;
      element.failure = timeoutFailure(1_002_000);
      element.onRetry = retry;
      element.onRaiseLimit = raise;
    });

    expect(alertRegion(timeout)).not.toBeNull();
    expect(noticeText(timeout)).toContain("Remote Lab didn't answer within 2:00");
    expect(noticeText(timeout)).toContain("Waited 0:02.");
    clickButton(timeout, "Try again");
    clickButton(timeout, "Raise limit");
    expect(retry).toHaveBeenCalledOnce();
    expect(raise).toHaveBeenCalledOnce();
    expect(activeIntervals()).toBe(0);

    const transferRetry = vi.fn();
    const transferRaise = vi.fn();
    const transfer = await renderNotice((element) => {
      element.machine = remoteMachine;
      element.failure = transferFailure(1_003_000, "Remote <Lab>");
      element.onRetry = transferRetry;
      element.onRaiseLimit = transferRaise;
    });
    expect(alertRegion(transfer)).not.toBeNull();
    expect(noticeText(transfer)).toContain("stopped responding while sending sessions");
    expect(noticeText(transfer)).toContain("Waited 0:03.");
    expect(shadowHtml(transfer)).toContain("Remote &lt;Lab&gt;");
    expect(shadowHtml(transfer)).not.toContain("<Lab>");
    expect(buttonLabels(transfer)).toEqual(["Try again", "Raise limit"]);
    clickButton(transfer, "Try again");
    clickButton(transfer, "Raise limit");
    expect(transferRetry).toHaveBeenCalledOnce();
    expect(transferRaise).toHaveBeenCalledOnce();
    expect(activeIntervals()).toBe(0);
  });

  it("keeps one owner clock instead of replacing it when a retry read takes over", async () => {
    const clock = fakeClock(LOAD_STARTED_AT);
    const createInterval = vi.spyOn(window, "setInterval");
    const notice = await renderNotice((element) => {
      element.machine = remoteMachine;
      element.load = selectionLoad();
      element.now = clock.now;
    });
    expect(activeIntervals()).toBe(1);
    expect(createInterval).toHaveBeenCalledOnce();

    notice.load = selectionLoad({ owner: "retry" });
    await notice.updateComplete;
    expect(activeIntervals()).toBe(1);
    expect(createInterval).toHaveBeenCalledOnce();

    // The surviving interval is the live one: it still drives the elapsed text.
    clock.advance(SESSION_LIST_NOTICE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(SESSION_LIST_NOTICE_DELAY_MS);
    await notice.updateComplete;
    expect(noticeText(notice)).toContain("Loading sessions from Remote Lab… 0:05 of 2:00");
  });

  it("stops the owner clock on scope loss, failure, record loss, and disconnect", async () => {
    const clock = fakeClock(LOAD_STARTED_AT);
    const notice = await renderNotice((element) => {
      element.machine = remoteMachine;
      element.load = selectionLoad();
      element.now = clock.now;
    });
    expect(activeIntervals()).toBe(1);

    notice.load = selectionLoad({ machineId: "/other" });
    await notice.updateComplete;
    expect(activeIntervals()).toBe(0);

    notice.load = selectionLoad();
    await notice.updateComplete;
    expect(activeIntervals()).toBe(1);

    notice.failure = timeoutFailure(1_010_000);
    await notice.updateComplete;
    expect(activeIntervals()).toBe(0);

    notice.failure = undefined;
    notice.load = selectionLoad();
    await notice.updateComplete;
    expect(activeIntervals()).toBe(1);

    notice.load = undefined;
    await notice.updateComplete;
    expect(activeIntervals()).toBe(0);

    notice.load = selectionLoad();
    await notice.updateComplete;
    expect(activeIntervals()).toBe(1);

    notice.remove();
    expect(activeIntervals()).toBe(0);
  });

  it("does not restart the clock when a pending update flushes after disconnect", async () => {
    const clock = fakeClock(LOAD_STARTED_AT);
    const notice = await renderNotice((element) => {
      element.machine = remoteMachine;
      element.load = selectionLoad();
      element.now = clock.now;
    });
    expect(activeIntervals()).toBe(1);

    // Schedule an update, then detach before its microtask flush: Lit still
    // performs the update on the detached element.
    notice.load = selectionLoad({ owner: "retry" });
    notice.remove();
    expect(activeIntervals()).toBe(0);

    await notice.updateComplete;
    expect(activeIntervals()).toBe(0);
  });
});

interface TestClock {
  readonly now: () => number;
  advance: (ms: number) => void;
}

function fakeClock(startedAt: number): TestClock {
  let time = startedAt;
  return {
    now: () => time,
    advance: (ms: number) => { time += ms; },
  };
}

async function renderNotice(configure: (element: SessionListLoadNotice) => void): Promise<SessionListLoadNotice> {
  const element = new SessionListLoadNotice();
  configure(element);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

async function renderedText(machine: Machine, load: SessionListLoad, failure: SessionListFailure | undefined): Promise<string> {
  const notice = await renderNotice((element) => {
    element.machine = machine;
    element.load = load;
    element.failure = failure;
  });
  return noticeText(notice);
}

function selectionLoad(overrides: Partial<SessionListLoad> & { machineId?: string } = {}): SessionListLoad {
  const { machineId, ...loadOverrides } = overrides;
  return {
    owner: "selection",
    scope: { machineId: machineId ?? remoteMachine.id, projectId: "project", workspaceId: "workspace", workspacePath: "/repo" },
    startedAt: LOAD_STARTED_AT,
    budgetMs: REMOTE_BUDGET_MS,
    phase: "waiting",
    ...loadOverrides,
  };
}

function localSelectionLoad(): SessionListLoad {
  return selectionLoad({ machineId: localMachine.id });
}

function timeoutFailure(endedAt: number, machineName = remoteMachine.name): SessionListFailure {
  return failure("timeout", endedAt, machineName);
}

function transferFailure(endedAt: number, machineName = remoteMachine.name): SessionListFailure {
  return failure("transfer", endedAt, machineName);
}

function failure(kind: SessionListFailure["kind"], endedAt: number, machineName: string): SessionListFailure {
  return {
    scope: { machineId: remoteMachine.id, machineName, projectId: "project", workspaceId: "workspace" },
    kind,
    elapsedMs: endedAt - LOAD_STARTED_AT,
    budgetMs: REMOTE_BUDGET_MS,
  };
}

function noticeText(notice: SessionListLoadNotice): string {
  return notice.shadowRoot?.querySelector(".session-list-load-notice")?.textContent ?? "";
}

function shadowHtml(notice: SessionListLoadNotice): string {
  return notice.shadowRoot?.innerHTML ?? "";
}

function statusRegion(notice: SessionListLoadNotice): HTMLElement | null {
  return notice.shadowRoot?.querySelector<HTMLElement>('[role="status"]') ?? null;
}

function alertRegion(notice: SessionListLoadNotice): HTMLElement | null {
  return notice.shadowRoot?.querySelector<HTMLElement>('[role="alert"]') ?? null;
}

function buttonLabels(notice: SessionListLoadNotice): string[] {
  return buttons(notice).map((button) => button.textContent.trim());
}

function clickButton(notice: SessionListLoadNotice, label: string): void {
  const button = buttons(notice).find((candidate) => candidate.textContent.trim() === label);
  if (button === undefined) throw new Error(`Expected the ${label} action`);
  button.click();
}

function buttons(notice: SessionListLoadNotice): HTMLButtonElement[] {
  const root = notice.shadowRoot;
  return root === null ? [] : [...root.querySelectorAll<HTMLButtonElement>("button")];
}

function activeIntervals(): number {
  return vi.getTimerCount();
}
