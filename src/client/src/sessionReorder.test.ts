import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import type { SessionRow } from "./sessionTreeRows";
import {
  eligibleSessionReorderGroup,
  moveSessionInGroup,
  sessionReorderEdgeScrollDelta,
  sessionReorderInsertionIndex,
  sessionReorderRequest,
  sessionReorderSubtreePaths,
  sessionReorderThresholdReached,
} from "./sessionReorder";

function session(id: string, cwd = "/repo", patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    persisted: true,
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: "",
    ...patch,
  };
}

function row(value: SessionInfo, depth: number, external = false, hasMissingParent = false): SessionRow {
  return { session: value, depth, external, hasMissingParent, hasChildren: false, folded: false };
}

describe("session sidebar reorder domain", () => {
  it("finds only persisted current peers in the exact root/pin group", () => {
    const selected = session("selected", "/repo");
    const rows = [
      row(selected, 0),
      row(session("peer", "/repo"), 0),
      row(session("other-workspace", "/feature"), 0, true),
      row(session("pinned", "/repo", { pinned: true }), 0),
      row(session("transient", "/repo", { persisted: false }), 0),
      row(session("archived", "/repo", { archived: true }), 0),
    ];
    expect(eligibleSessionReorderGroup(rows, selected, "/repo").map(({ id }) => id))
      .toEqual(["selected", "peer"]);
  });

  it("keeps a promoted missing-parent child read-only until its parent is projected", () => {
    const orphan = session("orphan", "/repo", {
      parentSessionPath: "/sessions/missing-parent.jsonl",
    });
    expect(eligibleSessionReorderGroup([row(orphan, 0, false, true)], orphan, "/repo"))
      .toEqual([]);
  });

  it("allows cross-workspace child peers only under the exact same parent", () => {
    const parentSessionPath = "/sessions/parent.jsonl";
    const selected = session("selected", "/repo", { parentSessionPath });
    const rows = [
      row(selected, 1),
      row(session("peer", "/feature", { parentSessionPath }), 1, true),
      row(session("other-parent", "/repo", { parentSessionPath: "/sessions/other.jsonl" }), 1),
    ];
    expect(eligibleSessionReorderGroup(rows, selected, "/repo").map(({ id }) => id))
      .toEqual(["selected", "peer"]);
    const peerRow = rows[1];
    if (peerRow === undefined) throw new Error("Missing child peer");
    expect(sessionReorderRequest(selected, [selected, peerRow.session], ["/repo", "/feature"]))
      .toEqual({
        cwd: "/repo",
        scope: { kind: "children", parentSessionPath: "/sessions/parent.jsonl" },
        pinned: false,
        catalogCwds: ["/repo", "/feature"],
        orderedSessions: [
          { id: "selected", cwd: "/repo" },
          { id: "peer", cwd: "/feature" },
        ],
      });
  });

  it("moves against the remaining peer slots and detects no-op positions", () => {
    const group = [session("first"), session("selected"), session("last")];
    expect(moveSessionInGroup(group, "selected", 0).map(({ id }) => id))
      .toEqual(["selected", "first", "last"]);
    expect(moveSessionInGroup(group, "selected", 1).map(({ id }) => id))
      .toEqual(["first", "selected", "last"]);
    expect(moveSessionInGroup(group, "selected", 2).map(({ id }) => id))
      .toEqual(["first", "last", "selected"]);
  });

  it("refuses groups or project catalogs beyond the shared protocol limit", () => {
    const selected = session("selected");
    const oversized = Array.from({ length: 1_001 }, (_, index) => session(`s-${String(index)}`));
    expect(() => sessionReorderRequest(selected, oversized, ["/repo"]))
      .toThrow("Session reorder exceeds the 1000-entry limit");
    expect(() => sessionReorderRequest(
      selected,
      [selected, session("peer")],
      Array.from({ length: 1_001 }, (_, index) => `/repo-${String(index)}`),
    )).toThrow("Session reorder exceeds the 1000-entry limit");
  });

  it("returns one sibling's complete depth-first subtree without crossing its next sibling", () => {
    const parent = session("parent");
    const first = session("first", "/repo", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", "/repo", { parentSessionPath: first.path });
    const second = session("second", "/repo", { parentSessionPath: parent.path });
    const rows = [row(parent, 0), row(first, 1), row(grandchild, 2), row(second, 1)];
    expect(sessionReorderSubtreePaths(rows, first.path)).toEqual([first.path, grandchild.path]);
    expect(sessionReorderSubtreePaths(rows, second.path)).toEqual([second.path]);
  });

  it("uses exact threshold, midpoint slots, and bounded proportional edge scrolling", () => {
    expect(sessionReorderThresholdReached({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(false);
    expect(sessionReorderThresholdReached({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true);
    expect(sessionReorderInsertionIndex(49, [
      { sessionPath: "/sessions/a.jsonl", top: 0, bottom: 40 },
      { sessionPath: "/sessions/b.jsonl", top: 60, bottom: 100 },
    ])).toBe(1);
    expect(sessionReorderInsertionIndex(100, [
      { sessionPath: "/sessions/a.jsonl", top: 0, bottom: 40 },
      { sessionPath: "/sessions/b.jsonl", top: 60, bottom: 100 },
    ])).toBe(2);
    expect(sessionReorderEdgeScrollDelta(0, 0, 200)).toBe(-12);
    expect(sessionReorderEdgeScrollDelta(16, 0, 200)).toBe(-6);
    expect(sessionReorderEdgeScrollDelta(100, 0, 200)).toBe(0);
    expect(sessionReorderEdgeScrollDelta(200, 0, 200)).toBe(12);
  });
});
