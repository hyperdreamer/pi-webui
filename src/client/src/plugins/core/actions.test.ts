import { describe, expect, it } from "vitest";
import { createCoreActions } from "./actions";

describe("createCoreActions", () => {
  it("closes the action palette only for focus, reveal, and dialog actions", () => {
    const closing = createCoreActions().filter((action) => action.closesActionPalette === true).map((action) => action.id);

    expect([...closing].sort()).toEqual([
      "auth.login",
      "auth.logout",
      "machine.add",
      "machine.remove",
      "project.add",
      "prompt.focus",
      "session.start",
      "settings.open",
      "theme.select",
      "view.chat",
      "view.files",
      "view.git",
      "view.terminal",
      "workspace.delete",
    ]);
  });

  it("leaves repeatable actions able to run back to back", () => {
    const actions = createCoreActions();
    const persistent = ["actions.show", "machine.refresh", "machine.open", "workspace.refresh-files", "workspace.refresh-git", "workspace.refresh-current", "session.archive", "session.reload", "session.delete", "session.stop", "app.reload-page"];

    for (const id of persistent) {
      expect(actions.find((action) => action.id === id)?.closesActionPalette, id).toBeUndefined();
    }
  });
});
