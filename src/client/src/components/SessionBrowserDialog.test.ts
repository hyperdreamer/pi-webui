import { describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { templateClickHandlerForText, templateText } from "../templateInspection.testSupport";
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

  it("selects a session through the supplied callback", () => {
    const target = session("target", { firstMessage: "Open me" });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [target];
    const onSelect = vi.fn();
    dialog.onSelect = onSelect;

    templateClickHandlerForText(dialog.render(), "Open me")(new Event("click"));

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
});
