import { describe, expect, it } from "vitest";
import { clickOutsideActionMenu } from "./actionMenu.testSupport";
import { WorkspaceList } from "./WorkspaceList";

describe("workspace action menu dismissal", () => {
  it("closes an open menu when another part of the workspace list is clicked", () => {
    const list = new WorkspaceList();
    Reflect.set(list, "openMenuWorkspaceId", "open-menu");

    clickOutsideActionMenu(list);

    expect(Reflect.get(list, "openMenuWorkspaceId")).toBeUndefined();
  });
});
