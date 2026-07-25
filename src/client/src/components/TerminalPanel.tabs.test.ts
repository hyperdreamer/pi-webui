import type { TerminalInfo } from "../api";
import { describe, expect, it, vi } from "vitest";
// This node-environment test narrowly verifies terminal-tab click wiring; a DOM
// harness would add disproportionate setup for this isolated component boundary.
import { templateEventHandlerAfterMarker, templateText } from "../templateInspection.testSupport";
import { TerminalPanel } from "./TerminalPanel";

describe("TerminalPanel terminal tabs", () => {
  it("renders a dedicated full-size close button for each shell tab", () => {
    const panel = new TerminalPanel();
    Reflect.set(panel, "terminals", [terminal("shell-1", "Shell 1")]);
    Reflect.set(panel, "selectedId", "shell-1");

    const rendered = panel.render();
    const markup = templateText(rendered);
    const close = templateEventHandlerAfterMarker(rendered, 'class="terminal-tab-close"');
    const event = new TerminalTabCloseEvent("click");
    close(event);

    expect(markup).toContain("terminal-tab selected");
    expect(markup).toContain('class="terminal-tab-close"');
    expect(markup).toContain("Close Shell 1");
    expect(event.stop).toHaveBeenCalledOnce();
    expect(TerminalPanel.styles.cssText).toMatch(/\.terminal-tab-close\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/);
  });
});

class TerminalTabCloseEvent extends Event {
  readonly stop = vi.fn();

  override stopPropagation(): void {
    this.stop();
  }
}

function terminal(id: string, name: string): TerminalInfo {
  return { id, name, cwd: "/repo", createdAt: "2026-01-01T00:00:00.000Z", exited: false };
}
