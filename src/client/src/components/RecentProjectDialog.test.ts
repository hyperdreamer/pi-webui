// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentProjectEntry } from "../../../shared/apiTypes";
import { RecentProjectDialog, type RecentProjectDialogView } from "./RecentProjectDialog";

const dialogPrototype = HTMLDialogElement.prototype;
const originalShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, "close");
const showModal = vi.fn(function (this: HTMLDialogElement): void {
  this.open = true;
});
const close = vi.fn(function (this: HTMLDialogElement): void {
  this.open = false;
});

function restoreDialogMethod(name: "showModal" | "close", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(dialogPrototype, name);
  else Object.defineProperty(dialogPrototype, name, descriptor);
}

beforeEach(() => {
  showModal.mockClear();
  close.mockClear();
  Object.defineProperty(dialogPrototype, "showModal", { configurable: true, writable: true, value: showModal });
  Object.defineProperty(dialogPrototype, "close", { configurable: true, writable: true, value: close });
});

afterEach(() => {
  restoreDialogMethod("showModal", originalShowModal);
  restoreDialogMethod("close", originalClose);
  vi.restoreAllMocks();
});

const entry: RecentProjectEntry = { id: "e1", name: "alpha", path: "/work/alpha", lastUsedAt: "2026-01-01T00:00:00.000Z" };

interface MountOverrides {
  entry?: RecentProjectEntry;
  initialView?: RecentProjectDialogView;
  onReopen?: (entry: RecentProjectEntry) => Promise<void>;
  onRemove?: (entry: RecentProjectEntry) => Promise<void>;
  onClose?: () => void;
}

async function mount(overrides: MountOverrides = {}): Promise<{ dialog: RecentProjectDialog; teardown: () => void }> {
  await import("./RecentProjectDialog");
  const dialog = new RecentProjectDialog();
  Object.assign(dialog, {
    entry,
    initialView: "closed-actions",
    onReopen: () => Promise.resolve(),
    onRemove: () => Promise.resolve(),
    onClose: () => undefined,
    ...overrides,
  });
  document.body.append(dialog);
  await dialog.updateComplete;
  return { dialog, teardown: () => { dialog.remove(); } };
}

function button(dialog: RecentProjectDialog, selector: string): HTMLButtonElement {
  const found = dialog.renderRoot.querySelector<HTMLButtonElement>(selector);
  if (found === null) throw new Error(`expected ${selector}`);
  return found;
}

function nativeDialog(dialog: RecentProjectDialog): HTMLDialogElement {
  const found = dialog.renderRoot.querySelector<HTMLDialogElement>("dialog");
  if (found === null) throw new Error("expected dialog");
  return found;
}

/** jsdom retargets document.activeElement to the shadow host; the shadow root reports the real target. */
function activeElement(dialog: RecentProjectDialog): Element | null {
  return dialog.shadowRoot?.activeElement ?? document.activeElement;
}

describe("recent-project-dialog closed actions", () => {
  it("identifies the Closed entry and offers Reopen, Remove from history, and Cancel", async () => {
    const { dialog, teardown } = await mount();

    expect(dialog.renderRoot.textContent).toContain("alpha");
    expect(dialog.renderRoot.textContent).toContain("/work/alpha");
    expect(dialog.renderRoot.textContent).toContain("no longer registered");
    const labels = Array.from(dialog.renderRoot.querySelectorAll("button")).map((b) => b.textContent.trim());
    expect(labels).toEqual(expect.arrayContaining(["Reopen", "Remove from history", "Cancel"]));

    teardown();
  });

  it("focuses Reopen when opened in the Closed-actions view", async () => {
    const { dialog, teardown } = await mount();

    expect(activeElement(dialog)).toBe(button(dialog, ".recent-project-reopen"));

    teardown();
  });

  it("moves to removal confirmation in place and focuses Cancel without invoking onRemove", async () => {
    const onRemove = vi.fn();
    const onReopen = vi.fn();
    const { dialog, teardown } = await mount({ onRemove, onReopen });

    button(dialog, ".recent-project-remove-request").click();

    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("Remove from Recent Projects?");
    });
    expect(dialog.renderRoot.querySelectorAll("dialog").length).toBe(1);
    expect(dialog.renderRoot.querySelector(".recent-project-reopen")).toBeNull();
    expect(button(dialog, ".recent-project-confirm-remove")).toBeDefined();
    expect(onRemove).not.toHaveBeenCalled();
    expect(onReopen).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(activeElement(dialog)).toBe(button(dialog, ".recent-project-cancel"));
    });

    teardown();
  });

  it("reopens the project and closes only after success", async () => {
    let resolveReopen!: () => void;
    const onReopen = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveReopen = resolve; }));
    const onClose = vi.fn();
    const { dialog, teardown } = await mount({ onReopen, onClose });

    button(dialog, ".recent-project-reopen").click();
    expect(onReopen).toHaveBeenCalledWith(entry);
    expect(onClose).not.toHaveBeenCalled();

    resolveReopen();
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    expect(onReopen).toHaveBeenCalledTimes(1);

    teardown();
  });

  it("keeps the Closed-actions view and re-enables actions after a failed reopen", async () => {
    const onClose = vi.fn();
    const { dialog, teardown } = await mount({
      onReopen: () => Promise.reject(new Error("Project path must be a directory")),
      onClose,
    });

    button(dialog, ".recent-project-reopen").click();
    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("Project path must be a directory");
    });

    const error = dialog.renderRoot.querySelector(".recent-project-error");
    expect(error?.getAttribute("role")).toBe("status");
    expect(dialog.renderRoot.textContent).toContain("no longer registered");
    expect(dialog.renderRoot.querySelector(".recent-project-confirm-remove")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(button(dialog, ".recent-project-reopen").disabled).toBe(false);
    expect(button(dialog, ".recent-project-cancel").disabled).toBe(false);

    teardown();
  });

  it("resets to the incoming initial view when a new entry arrives", async () => {
    const { dialog, teardown } = await mount();
    button(dialog, ".recent-project-remove-request").click();
    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("Remove from Recent Projects?");
    });

    dialog.entry = { id: "e2", name: "beta", path: "/work/beta", lastUsedAt: "2026-01-02T00:00:00.000Z" };
    dialog.initialView = "closed-actions";
    await dialog.updateComplete;

    expect(dialog.renderRoot.textContent).toContain("beta");
    expect(dialog.renderRoot.textContent).toContain("/work/beta");
    expect(dialog.renderRoot.textContent).toContain("no longer registered");
    expect(dialog.renderRoot.textContent).not.toContain("Remove from Recent Projects?");

    teardown();
  });
});

describe("recent-project-dialog removal confirmation", () => {
  it("opens directly in the removal-confirmation view and focuses Cancel", async () => {
    const { dialog, teardown } = await mount({ initialView: "removal-confirmation" });

    expect(dialog.renderRoot.textContent).toContain("Remove from Recent Projects?");
    expect(dialog.renderRoot.textContent).toContain("alpha");
    expect(dialog.renderRoot.textContent).toContain("/work/alpha");
    expect(dialog.renderRoot.querySelector(".recent-project-reopen")).toBeNull();
    expect(activeElement(dialog)).toBe(button(dialog, ".recent-project-cancel"));

    teardown();
  });

  it("explains that removal changes only Recent Projects history", async () => {
    const { dialog, teardown } = await mount({ initialView: "removal-confirmation" });

    const text = dialog.renderRoot.textContent;
    expect(text).toContain("Only the Recent Projects entry");
    expect(text).toContain("No project files will be deleted");
    expect(text).toContain("registration is unaffected");
    expect(text).toContain("Recent Projects again");
    expect(text).not.toContain("missing");

    teardown();
  });

  it("removes the history entry and closes only after success", async () => {
    let resolveRemove!: () => void;
    const onRemove = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveRemove = resolve; }));
    const onClose = vi.fn();
    const { dialog, teardown } = await mount({ initialView: "removal-confirmation", onRemove, onClose });

    button(dialog, ".recent-project-confirm-remove").click();
    expect(onRemove).toHaveBeenCalledWith(entry);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    resolveRemove();
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });

    teardown();
  });

  it("keeps the confirmation open and re-enables actions after a failed removal", async () => {
    const onClose = vi.fn();
    const { dialog, teardown } = await mount({
      initialView: "removal-confirmation",
      onRemove: () => Promise.reject(new Error("The machine is unavailable")),
      onClose,
    });

    button(dialog, ".recent-project-confirm-remove").click();
    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("The machine is unavailable");
    });

    const error = dialog.renderRoot.querySelector(".recent-project-error");
    expect(error?.getAttribute("role")).toBe("status");
    expect(dialog.renderRoot.textContent).toContain("Remove from Recent Projects?");
    expect(onClose).not.toHaveBeenCalled();
    expect(button(dialog, ".recent-project-confirm-remove").disabled).toBe(false);
    expect(button(dialog, ".recent-project-cancel").disabled).toBe(false);

    teardown();
  });
});

describe("recent-project-dialog dismissal", () => {
  async function assertClosesWhenIdle(initialView: RecentProjectDialogView): Promise<void> {
    const cancelled = vi.fn();
    const first = await mount({ initialView, onClose: cancelled });
    button(first.dialog, ".recent-project-cancel").click();
    expect(cancelled).toHaveBeenCalledTimes(1);
    first.teardown();

    const escaped = vi.fn();
    const second = await mount({ initialView, onClose: escaped });
    nativeDialog(second.dialog).dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(escaped).toHaveBeenCalledTimes(1);
    second.teardown();

    const backdropped = vi.fn();
    const third = await mount({ initialView, onClose: backdropped });
    nativeDialog(third.dialog).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(backdropped).toHaveBeenCalledTimes(1);
    third.teardown();
  }

  it("closes from the Closed-actions view on Cancel, Escape, and backdrop when idle", async () => {
    await assertClosesWhenIdle("closed-actions");
  });

  it("closes from the removal-confirmation view on Cancel, Escape, and backdrop when idle", async () => {
    await assertClosesWhenIdle("removal-confirmation");
  });
});

describe("recent-project-dialog busy state", () => {
  it("disables every button and ignores Cancel, Escape, and backdrop while an action runs", async () => {
    let resolveReopen!: () => void;
    const onReopen = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveReopen = resolve; }));
    const onClose = vi.fn();
    const { dialog, teardown } = await mount({ onReopen, onClose });

    button(dialog, ".recent-project-reopen").click();
    await vi.waitFor(() => {
      expect(button(dialog, ".recent-project-reopen").disabled).toBe(true);
    });

    const buttons = Array.from(dialog.renderRoot.querySelectorAll("button"));
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(nativeDialog(dialog).getAttribute("aria-busy")).toBe("true");

    button(dialog, ".recent-project-cancel").click();
    nativeDialog(dialog).dispatchEvent(new Event("cancel", { cancelable: true }));
    nativeDialog(dialog).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();

    resolveReopen();
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    expect(onReopen).toHaveBeenCalledTimes(1);

    teardown();
  });
});

describe("recent-project-dialog frame", () => {
  it("bounds the frame width at narrow viewports and exposes modal labeling and busy state", async () => {
    const frameRule = /\.recent-project-frame\s*\{[^}]*\}/.exec(RecentProjectDialog.styles.cssText)?.[0];
    const nativeRule = /(?:^|\s)dialog\s*\{[^}]*\}/.exec(RecentProjectDialog.styles.cssText)?.[0];

    expect(frameRule).toMatch(/box-sizing:\s*border-box/);
    expect(frameRule).toMatch(/max-width:\s*calc\(100vw - 24px\)/);
    expect(nativeRule).toMatch(/max-width:\s*calc\(100vw - 24px\)/);

    const { dialog, teardown } = await mount();
    const native = nativeDialog(dialog);
    expect(native.getAttribute("aria-modal")).toBe("true");
    const labelledBy = native.getAttribute("aria-labelledby");
    if (labelledBy === null) throw new Error("expected aria-labelledby");
    expect(dialog.renderRoot.querySelector(`#${labelledBy}`)).not.toBeNull();
    expect(native.getAttribute("aria-busy")).toBe("false");

    teardown();
  });
});
