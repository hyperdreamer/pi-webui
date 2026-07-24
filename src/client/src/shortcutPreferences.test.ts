import { describe, expect, it } from "vitest";
import type { AppAction } from "./actions";
import { applyActiveShortcutPreferences, applyShortcutPreferences } from "./shortcutPreferences";

const noop = () => undefined;

describe("shortcut preferences", () => {
  it("keeps default shortcuts when there is no matching preference", () => {
    const actions = [action({ id: "core:view.chat", shortcut: "mod+1" })];

    expect(applyShortcutPreferences(actions, { "core:view.files": "mod+2" })).toEqual(actions);
  });

  it("overrides action shortcuts by action id", () => {
    expect(applyShortcutPreferences([
      action({ id: "core:view.chat", shortcut: "mod+1" }),
    ], { "core:view.chat": "mod+shift+1" })).toEqual([
      action({ id: "core:view.chat", shortcut: "mod+shift+1" }),
    ]);
  });

  it("removes shortcuts with null preferences", () => {
    expect(applyShortcutPreferences([
      action({ id: "core:view.chat", shortcut: "mod+1" }),
    ], { "core:view.chat": null })).toEqual([
      action({ id: "core:view.chat" }),
    ]);
  });

  it("keeps only active shortcuts when applying preferences for display", () => {
    expect(applyActiveShortcutPreferences([
      action({ id: "core:z", title: "Later", shortcut: "mod+k" }),
      action({ id: "core:a", title: "Earlier", shortcut: "mod+k" }),
    ], undefined)).toEqual([
      action({ id: "core:z", title: "Later" }),
      action({ id: "core:a", title: "Earlier", shortcut: "mod+k" }),
    ]);
  });

  it("hides default shortcut labels shadowed by user-defined shortcuts", () => {
    expect(applyActiveShortcutPreferences([
      action({ id: "core:a", title: "Default", shortcut: "mod+1" }),
      action({ id: "core:z", title: "Custom", shortcut: "mod+2" }),
    ], { "core:z": "mod+1" })).toEqual([
      action({ id: "core:a", title: "Default" }),
      action({ id: "core:z", title: "Custom", shortcut: "mod+1" }),
    ]);
  });
});

function action(patch: Partial<AppAction>): AppAction {
  return { id: "action", title: "Action", run: noop, ...patch };
}
