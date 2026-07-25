import { afterEach, describe, expect, it, vi } from "vitest";
import { isTemplateResult, templateEventHandlerNearMarker, templateStrings, templateValueAfterMarker } from "../templateInspection.testSupport";
import { SessionHistoryWindow } from "./SessionHistoryWindow";

const session = {
  id: "session /?",
  cwd: "/repo with spaces/?",
  path: "/sessions/session.jsonl",
  persisted: true,
  created: "2026-06-04T00:00:00.000Z",
  modified: "2026-06-04T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "Inspect the full history",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session-history-window", () => {
  it("embeds the encoded history export in a sandboxed application window", () => {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    const window = new SessionHistoryWindow();
    window.machineId = "remote /?";
    window.session = session;

    const rendered = window.render();

    expect(templateValueAfterMarker(rendered, "src=")).toBe(
      "https://pi.example.test/api/machines/remote%20%2F%3F/sessions/session%20%2F%3F/export?cwd=%2Frepo+with+spaces%2F%3F",
    );
    const iframeTemplate = templateValueAfterMarker(rendered, '<div class="history-body">');
    if (!isTemplateResult(iframeTemplate)) throw new Error("Expected the history frame template");
    expect(templateStrings(iframeTemplate).join("")).toContain('sandbox="allow-scripts"');
    expect(templateStrings(iframeTemplate).join("")).toContain('referrerpolicy="no-referrer"');
  });

  it("closes from the window's close control", () => {
    const window = new SessionHistoryWindow();
    const onClose = vi.fn();
    window.onClose = onClose;

    // The node test environment has no custom-element DOM harness; this is a
    // narrow check of the user-visible close-button wiring.
    templateEventHandlerNearMarker(window.render(), 'aria-label="Close full history"')(new Event("click"));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
