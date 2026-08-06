import { describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { templateClickHandlerForText, templateEventHandlerAfterValue, templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
import { sessionLabel } from "../sessionLabels";
import { SessionBrowserDialog } from "./SessionBrowserDialog";

const session = (id: string, patch: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  path: `/sessions/${id}.jsonl`,
  cwd: "/workspace",
  created: "2026-07-29T00:00:00.000Z",
  modified: "2026-07-29T00:00:00.000Z",
  messageCount: 1,
  firstMessage: id,
  ...patch,
});

const status = (sessionId: string, patch: Partial<SessionStatus> = {}): SessionStatus => ({
  sessionId,
  isStreaming: false,
  isCompacting: false,
  isBashRunning: false,
  pendingMessageCount: 0,
  queuedMessages: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
  ...patch,
});

describe("SessionBrowserDialog", () => {
  it("gives disclosure buttons a larger hit target and pinned-star hover feedback", () => {
    const styles = sessionBrowserDialogStyles();

    expect(styles).toMatch(/\.session-group-toggle\s*\{[^}]*width:\s*24px;/);
    expect(styles).toMatch(/\.session-group-toggle\s*\{[^}]*min-width:\s*24px;/);
    expect(styles).toMatch(/\.session-group-toggle\s*\{[^}]*height:\s*24px;/);
    expect(styles).toMatch(/\.session-group-toggle:hover\s*\{[^}]*background:\s*var\(--pi-surface\);/);
    expect(styles).toMatch(/\.session-group-toggle:hover\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--pi-border\);/);
    expect(styles).toMatch(/\.session-group-toggle:hover\s*\{[^}]*transform:\s*scale\(1\.25\);/);
  });

  it("keeps the enlarged toggle out of the clamped label so wrapped titles stay legible", () => {
    const parent = session("parent", { firstMessage: "Coordinate the release" });
    const child = session("child", { parentSessionPath: parent.path, firstMessage: "Run checks" });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [parent, child];

    const markup = templateText(dialog.render());
    const lineIndex = markup.indexOf('class="action-name-line"');
    const toggleIndex = markup.indexOf('class="session-group-toggle"');
    const labelIndex = markup.indexOf('class="action-name"');
    const styles = sessionBrowserDialogStyles();

    // The label is line-clamped by `listStyles`, so an inline 24px button inside it
    // would inflate the clamped line box and slice the second line of wrapped titles.
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(toggleIndex).toBeGreaterThan(lineIndex);
    expect(labelIndex).toBeGreaterThan(toggleIndex);
    expect(styles).toMatch(/\.session-browser-row \.action-name-line\s*\{[^}]*min-width:\s*0;/);
    expect(styles).toMatch(/\.session-browser-row \.action-name-line\s*\{[^}]*display:\s*flex;/);
    expect(styles).toMatch(/\.session-browser-row \.action-name-line\s*\{[^}]*align-items:\s*flex-start;/);
    expect(styles).toMatch(/\.session-browser-row \.action-name-line \.action-name\s*\{[^}]*flex:\s*1 1 auto;/);
    expect(styles).toMatch(/\.session-browser-row \.action-name-line \.action-name\s*\{[^}]*min-width:\s*0;/);
  });

  it("browses the selected project's session tree and exposes descendant work", () => {
    const parent = session("parent", { firstMessage: "Coordinate release" });
    const child = session("child", { parentSessionPath: parent.path, firstMessage: "Run checks" });
    const dialog = new SessionBrowserDialog();
    dialog.projectName = "Web UI";
    dialog.sessions = [parent, child];
    dialog.statuses = { [child.id]: status(child.id, { isStreaming: true }) };

    const renderedText = templateText(dialog.render());

    expect(renderedText).toContain("Sessions · Web UI");
    expect(renderedText).toContain("Coordinate release");
    expect(renderedText).toContain("1 subsession working");
    expect(renderedText).toContain("activity-indicator descendant");
  });

  it("groups parent with children in a session-family-frame", () => {
    const parent = session("parent", { firstMessage: "Parent session" });
    const child = session("child", { parentSessionPath: parent.path, firstMessage: "Child session" });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [parent, child];
    // Expand so children are visible
    Reflect.set(dialog, "expandedSessionPaths", new Set([parent.path]));

    const renderedText = templateText(dialog.render());
    expect(renderedText).toContain("Parent session");
    expect(renderedText).toContain("Child session");
    // The frame class should be present in the template when children exist
    expect(renderedText).toContain("session-family-frame");
  });

  it("filters the project-scoped browser by session text while keeping the matching row selectable", () => {
    const first = session("first", { firstMessage: "Build feature" });
    const second = session("second", { firstMessage: "Investigate deployment" });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [first, second];
    Reflect.set(dialog, "searchQuery", "deploy");

    const renderedText = templateText(dialog.render());
    expect(renderedText).not.toContain("Build feature");
    expect(renderedText).toContain("Investigate deployment");
  });

  it("finds a matching child even when its session family starts folded", () => {
    const parent = session("parent", { firstMessage: "Coordinate release" });
    const child = session("child", { firstMessage: "Deploy the documentation", parentSessionPath: parent.path });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [parent, child];
    Reflect.set(dialog, "searchQuery", "deploy");

    const renderedText = templateText(dialog.render());
    expect(renderedText).toContain("Coordinate release");
    expect(renderedText).toContain("Deploy the documentation");
  });

  it("does not expose a mutable disclosure control while search results are unfolded", () => {
    const parent = session("parent", { firstMessage: "Parent context" });
    const child = session("child", { firstMessage: "Deploy result", parentSessionPath: parent.path });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [parent, child];
    Reflect.set(dialog, "expandedSessionPaths", new Set([parent.path]));
    Reflect.set(dialog, "searchQuery", "deploy");

    expect(templateText(dialog.render())).not.toContain("Collapse Parent context");
    expect(Reflect.get(dialog, "expandedSessionPaths")).toEqual(new Set([parent.path]));

    Reflect.set(dialog, "searchQuery", "");
    expect(templateText(dialog.render())).toContain("Collapse Parent context");
  });

  it("retains a current parent for a matching archived child", () => {
    const parent = session("parent", { firstMessage: "Current parent context" });
    const archivedChild = session("archived-child", {
      archived: true,
      archivedAt: "2026-07-30T00:00:00.000Z",
      firstMessage: "Deploy archived result",
      parentSessionPath: parent.path,
    });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [parent, archivedChild];
    Reflect.set(dialog, "searchQuery", "deploy");

    const rendered = templateText(dialog.render());
    expect(rendered).toContain("Current parent context");
    expect(rendered).toContain("Deploy archived result");
    expect(rendered).not.toContain("parent unavailable");
  });

  it("selects a session through the supplied callback", () => {
    const target = session("target", { firstMessage: "Open me" });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [target];
    const onSelect = vi.fn();
    dialog.onSelect = onSelect;

    // The row's click target is the row itself, not the star toggle, whose aria-label
    // embeds the same session label; anchor to the row's unique path instead.
    templateClickHandlerForText(dialog.render(), target.path)(new Event("click"));

    expect(onSelect).toHaveBeenCalledWith(target);
  });

  it("renders collapse toggle for a parent session with children", () => {
    const parent = session("parent", { firstMessage: "Parent" });
    const child = session("child", { parentSessionPath: parent.path, firstMessage: "Child" });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [parent, child];

    const renderedText = templateText(dialog.render());
    // Default collapsed state shows the expand arrow ▸
    expect(renderedText).toContain("▸");
    expect(renderedText).toContain("Expand Parent");
  });

  it("expands a collapsed session group", () => {
    const parent = session("parent", { firstMessage: "Parent" });
    const child = session("child", { parentSessionPath: parent.path, firstMessage: "Child" });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [parent, child];
    Reflect.set(dialog, "expandedSessionPaths", new Set([parent.path]));

    const renderedText = templateText(dialog.render());
    // Expanded state shows the collapse arrow ▾
    expect(renderedText).toContain("▾");
    expect(renderedText).toContain("Collapse Parent");
    // Child should still be visible when expanded
    expect(renderedText).toContain("Child");
  });

  it("keeps the expanded browser read-only while preserving manual session order", () => {
    const later = session("later", { firstMessage: "Later session", manualOrder: 1 });
    const first = session("first", { firstMessage: "First session", manualOrder: 0 });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [later, first];
    dialog.selected = first;

    const rendered = templateText(dialog.render());
    expect(rendered.indexOf("First session")).toBeLessThan(rendered.indexOf("Later session"));
    expect(rendered).not.toContain("session-reorder-grip");
    expect("onReorder" in dialog).toBe(false);
  });
});

describe("session browser pin controls", () => {
  it("pins an unpinned session from its row star without selecting the row", () => {
    const dialog = new SessionBrowserDialog();
    const target = session("plain");
    dialog.sessions = [target];
    const onPinSession = vi.fn();
    const onSelect = vi.fn();
    dialog.onPinSession = onPinSession;
    dialog.onSelect = onSelect;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    const rendered = dialog.render();

    // The star's title is an interpolated value, so anchor its handler to the
    // interpolated aria-label that precedes the @click binding (repo pattern).
    templateEventHandlerAfterValue(rendered, `Pin ${sessionLabel(target)}`, "@click=")(event);

    expect(onPinSession).toHaveBeenCalledWith(target);
    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    // Pin the star's visible and accessibility state: unpinned means aria-pressed="false" and ☆.
    expect(templateValueAfterMarker(rendered, "aria-pressed=")).toBe("false");
    expect(templateText(rendered)).toContain("☆");
  });

  it("unpins a pinned session from its row star", () => {
    const dialog = new SessionBrowserDialog();
    const target = session("starred", { pinned: true });
    dialog.sessions = [target];
    const onUnpinSession = vi.fn();
    dialog.onUnpinSession = onUnpinSession;
    const rendered = dialog.render();

    templateEventHandlerAfterValue(rendered, `Unpin ${sessionLabel(target)}`, "@click=")(new Event("click"));

    expect(onUnpinSession).toHaveBeenCalledWith(target);
    // Pin the star's visible and accessibility state: pinned means aria-pressed="true" and ★.
    expect(templateValueAfterMarker(rendered, "aria-pressed=")).toBe("true");
    expect(templateText(rendered)).toContain("★");
  });
});

function sessionBrowserDialogStyles(): string {
  const styles = SessionBrowserDialog.styles;
  const styleResults = Array.isArray(styles) ? styles : [styles];
  return styleResults.map((style) => style.cssText).join("\n");
}
