// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentProjectEntry } from "../../../shared/apiTypes";
import { ClosedRecentProjectDialog } from "./ClosedRecentProjectDialog";

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

async function mount(overrides: Partial<ClosedRecentProjectDialog> = {}): Promise<{ dialog: ClosedRecentProjectDialog; teardown: () => void }> {
  await import("./ClosedRecentProjectDialog");
  const dialog = new ClosedRecentProjectDialog();
  Object.assign(dialog, {
    entry,
    onReopen: () => Promise.resolve(),
    onRemove: () => Promise.resolve(),
    onClose: () => undefined,
    ...overrides,
  });
  document.body.append(dialog);
  await dialog.updateComplete;
  return { dialog, teardown: () => { dialog.remove(); } };
}

function button(dialog: ClosedRecentProjectDialog, selector: string): HTMLButtonElement {
  const found = dialog.renderRoot.querySelector<HTMLButtonElement>(selector);
  if (found === null) throw new Error(`expected ${selector}`);
  return found;
}

describe("closed-recent-project-dialog", () => {
  it("identifies the project without claiming the directory is missing", async () => {
    const { dialog, teardown } = await mount();

    expect(dialog.renderRoot.textContent).toContain("alpha");
    expect(dialog.renderRoot.textContent).toContain("/work/alpha");
    expect(dialog.renderRoot.textContent).toContain("no longer registered");
    expect(dialog.renderRoot.textContent).not.toContain("missing");
    expect(dialog.renderRoot.querySelector("[role=dialog], dialog")).not.toBeNull();

    teardown();
  });

  it("focuses Reopen first", async () => {
    const { dialog, teardown } = await mount();

    expect(dialog.shadowRoot?.activeElement ?? document.activeElement).toBe(button(dialog, ".closed-recent-reopen"));

    teardown();
  });

  it("reopens and closes on success", async () => {
    const onReopen = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const { dialog, teardown } = await mount({ onReopen, onClose });

    button(dialog, ".closed-recent-reopen").click();
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });

    expect(onReopen).toHaveBeenCalledWith(entry);
    teardown();
  });
});

describe("closed-recent-project-dialog failures", () => {
  it("keeps the dialog open and shows the error when reopening fails", async () => {
    const onClose = vi.fn();
    const { dialog, teardown } = await mount({
      onReopen: () => Promise.reject(new Error("Project path must be a directory")),
      onClose,
    });

    button(dialog, ".closed-recent-reopen").click();
    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("Project path must be a directory");
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(button(dialog, ".closed-recent-reopen").disabled).toBe(false);
    teardown();
  });

  it("removes history and closes, and reports a removal conflict without closing", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const removed = await mount({ onRemove, onClose });

    button(removed.dialog, ".closed-recent-remove").click();
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    expect(onRemove).toHaveBeenCalledWith(entry);
    removed.teardown();

    const conflictClose = vi.fn();
    const conflict = await mount({
      onRemove: () => Promise.reject(new Error("Recent project is registered")),
      onClose: conflictClose,
    });

    button(conflict.dialog, ".closed-recent-remove").click();
    await vi.waitFor(() => {
      expect(conflict.dialog.renderRoot.textContent).toContain("Recent project is registered");
    });

    expect(conflictClose).not.toHaveBeenCalled();
    conflict.teardown();
  });

  it("cancels without mutating on button, Escape, and backdrop", async () => {
    const onReopen = vi.fn();
    const onRemove = vi.fn();

    const cancelled = await mount({ onReopen, onRemove, onClose: vi.fn() });
    button(cancelled.dialog, ".closed-recent-cancel").click();
    expect(cancelled.dialog.onClose).toBeDefined();
    cancelled.teardown();

    const escaped = await mount({ onReopen, onRemove });
    const escapeClose = vi.fn();
    escaped.dialog.onClose = escapeClose;
    escaped.dialog.renderRoot.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(escapeClose).toHaveBeenCalledTimes(1);
    escaped.teardown();

    expect(onReopen).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
