import { describe, expect, it } from "vitest";
import { appStyles, chatStyles } from "./shared";

describe("chatStyles skill presentation", () => {
  it("uses the dedicated blue palette for skill activity and content", () => {
    const styles = chatStyles.cssText;

    expect(styles).toContain("--pi-skill: light-dark(#0969da, #58a6ff);");
    expect(styles).toContain("--pi-skill-border: light-dark(#0969da, #1f6feb);");
    expect(styles).toContain("--pi-skill-surface: light-dark(#ddf4ff, #0d2847);");
    expect(styles).toContain(".msg.skill { border-color: var(--pi-skill-border); background: var(--pi-skill-surface); }");
    expect(styles).toContain(".msg.skill > .msg-header { border-bottom-color: color-mix(in srgb, var(--pi-skill-border) 35%, transparent); background: var(--pi-skill-surface); }");
    expect(styles).toContain(".skill-invocation > summary, .skill-read > strong { color: var(--pi-skill); }");
  });
});

describe("Activity Rail shell placement", () => {
  it("overlays the desktop rail in a reserved navigation gutter instead of auto-placing it in the shell grid", () => {
    const styles = appStyles.cssText;

    expect(styles).toMatch(/\.shell > activity-rail\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;[^}]*align-self:\s*stretch;[^}]*\}/);
    expect(styles).toMatch(/@media \(min-width:\s*1181px\)\s*\{[\s\S]*?\.shell > aside\s*\{[^}]*padding-left:\s*44px;[^}]*\}/);
  });
});

describe("terminal modal header", () => {
  it("keeps adjusters beside the title and the close control at the far edge", () => {
    const styles = appStyles.cssText;

    expect(styles).toMatch(/\.terminal-modal-header\s*\{[^}]*justify-content:\s*flex-start;/);
    expect(styles).toMatch(/\.terminal-modal-drag-handle\s*\{[^}]*flex:\s*0 1 auto;/);
    expect(styles).toMatch(/\.terminal-modal-drag-spacer\s*\{[^}]*flex:\s*1 1 auto;/);
    expect(styles).toMatch(/\.terminal-modal-close\s*\{[^}]*flex:\s*0 0 auto;/);
  });
});
