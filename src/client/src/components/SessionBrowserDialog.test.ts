import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { isTemplateResult, templateClickHandlerForText, templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
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

type RenderResults = (this: SessionBrowserDialog) => TemplateResult;
type SessionRowsRepeatValues = readonly [readonly unknown[], (row: unknown) => unknown, (row: unknown) => TemplateResult];

function sessionRows(dialog: SessionBrowserDialog): {
  items: readonly unknown[];
  render: (row: unknown) => TemplateResult;
} {
  const renderResults: unknown = Reflect.get(dialog, "renderResults");
  if (!isRenderResults(renderResults)) throw new Error("Expected SessionBrowserDialog.renderResults");
  const rendered = renderResults.call(dialog);
  if (!isTemplateResult(rendered)) throw new Error("Expected a Lit template");
  const directive = templateValueAfterMarker(rendered, '<div class="session-list">');
  if (!isRecord(directive) || !isSessionRowsRepeatValues(directive["values"])) throw new Error("Expected session rows");
  const values = directive["values"];
  return { items: values[0], render: values[2] };
}

function isRenderResults(value: unknown): value is RenderResults {
  return typeof value === "function";
}

function isSessionRowsRepeatValues(value: unknown): value is SessionRowsRepeatValues {
  return Array.isArray(value)
    && Array.isArray(value[0])
    && typeof value[1] === "function"
    && typeof value[2] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("SessionBrowserDialog", () => {
  it("browses the selected project's session tree and exposes descendant work", () => {
    const parent = session("parent", { firstMessage: "Coordinate release" });
    const child = session("child", { parentSessionPath: parent.path, firstMessage: "Run checks" });
    const dialog = new SessionBrowserDialog();
    dialog.projectName = "Web UI";
    dialog.sessions = [parent, child];
    dialog.statuses = { [child.id]: status(child.id, { isStreaming: true }) };

    const rows = sessionRows(dialog);
    const parentRow = rows.render(rows.items[0]);

    expect(templateText(dialog.render())).toContain("Sessions · Web UI");
    expect(templateText(parentRow)).toContain("Coordinate release");
    expect(templateText(parentRow)).toContain("1 subsession working");
    expect(templateText(parentRow)).toContain("activity-indicator descendant");
  });

  it("filters the project-scoped browser by session text while keeping the matching row selectable", () => {
    const first = session("first", { firstMessage: "Build feature" });
    const second = session("second", { firstMessage: "Investigate deployment" });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [first, second];
    Reflect.set(dialog, "searchQuery", "deploy");

    const rows = sessionRows(dialog);
    expect(rows.items).toHaveLength(1);
    expect(templateText(rows.render(rows.items[0]))).toContain("Investigate deployment");
  });

  it("selects a session through the supplied callback", () => {
    const target = session("target", { firstMessage: "Open me" });
    const dialog = new SessionBrowserDialog();
    dialog.sessions = [target];
    const onSelect = vi.fn();
    dialog.onSelect = onSelect;

    templateClickHandlerForText(sessionRows(dialog).render(sessionRows(dialog).items[0]), "Open me")(new Event("click"));

    expect(onSelect).toHaveBeenCalledWith(target);
  });
});
