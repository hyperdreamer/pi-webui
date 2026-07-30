import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import { sessionRowsForSearch } from "./sessionTreeRows";

describe("sessionRowsForSearch", () => {
  it("keeps an archived matching child attached to its available current parent", () => {
    const parent = session("parent", "/workspace", { firstMessage: "Current parent" });
    const archivedChild = session("archived-child", "/workspace", {
      archived: true,
      archivedAt: "2026-07-30T00:00:00.000Z",
      firstMessage: "Deploy archived result",
      parentSessionPath: parent.path,
    });
    const unknownWorkspace = session("unknown", "/not-in-project", { firstMessage: "Excluded" });

    const rows = sessionRowsForSearch([parent, archivedChild, unknownWorkspace], {
      currentWorkspacePath: "/workspace",
      knownWorkspacePaths: new Set(["/workspace"]),
    });

    expect(rows.map((row) => ({ id: row.session.id, depth: row.depth, missing: row.hasMissingParent }))).toEqual([
      { id: "parent", depth: 0, missing: false },
      { id: "archived-child", depth: 1, missing: false },
    ]);
  });

  it("keeps archived roots and unfolds folded parent paths", () => {
    const archivedRoot = session("archived-root", "/workspace", {
      archived: true,
      archivedAt: "2026-07-30T00:00:00.000Z",
    });
    const parent = session("parent", "/workspace");
    const child = session("child", "/workspace", { parentSessionPath: parent.path });

    const rows = sessionRowsForSearch([archivedRoot, parent, child], {
      currentWorkspacePath: "/workspace",
      knownWorkspacePaths: new Set(["/workspace"]),
      foldedSessionPaths: new Set([parent.path]),
    });

    expect(rows.map((row) => ({ id: row.session.id, depth: row.depth, folded: row.folded }))).toEqual([
      { id: "archived-root", depth: 0, folded: false },
      { id: "parent", depth: 0, folded: false },
      { id: "child", depth: 1, folded: false },
    ]);
  });
});

function session(id: string, cwd: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-07-30T00:00:00.000Z",
    modified: "2026-07-30T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...patch,
  };
}
