import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import { sessionRows } from "./sessionTreeRows";

function session(id: string, cwd: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    persisted: true,
    created: "2026-08-04T00:00:00.000Z",
    modified: "2026-08-04T00:00:00.000Z",
    messageCount: 0,
    firstMessage: id,
    ...patch,
  };
}

function ids(sessions: SessionInfo[]): string[] {
  return sessionRows(sessions).map((row) => row.session.id);
}

describe("manual session tree order", () => {
  it("keeps all pinned roots first and applies positions only inside each root workspace", () => {
    expect(ids([
      session("a-two", "/a", { manualOrder: 2 }),
      session("b-one", "/b", { manualOrder: 1 }),
      session("a-new", "/a"),
      session("b-zero", "/b", { manualOrder: 0 }),
      session("a-zero", "/a", { manualOrder: 0 }),
      session("pinned", "/b", { pinned: true, manualOrder: 99 }),
    ])).toEqual(["pinned", "a-new", "a-zero", "a-two", "b-zero", "b-one"]);
  });

  it("orders children only under their exact parent and keeps pinned children first", () => {
    const parentA = session("parent-a", "/a");
    const parentB = session("parent-b", "/a");
    expect(ids([
      parentA,
      session("a-two", "/a", { parentSessionPath: parentA.path, manualOrder: 2 }),
      session("a-new", "/b", { parentSessionPath: parentA.path }),
      session("a-zero", "/a", { parentSessionPath: parentA.path, manualOrder: 0 }),
      session("a-pinned", "/a", { parentSessionPath: parentA.path, pinned: true, manualOrder: 7 }),
      parentB,
      session("b-child", "/a", { parentSessionPath: parentB.path, manualOrder: 0 }),
    ])).toEqual([
      "parent-a", "a-pinned", "a-new", "a-zero", "a-two",
      "parent-b", "b-child",
    ]);
  });

  it("moves a root family as one depth-first unit and preserves duplicate-position source order", () => {
    const later = session("later", "/a", { manualOrder: 1 });
    const first = session("first", "/a", { manualOrder: 0 });
    expect(ids([
      later,
      session("later-child", "/a", { parentSessionPath: later.path }),
      first,
      session("first-child", "/a", { parentSessionPath: first.path }),
      session("tie-a", "/a", { manualOrder: 2 }),
      session("tie-b", "/a", { manualOrder: 2 }),
    ])).toEqual(["first", "first-child", "later", "later-child", "tie-a", "tie-b"]);
  });

  it("does not compare an orphaned child's child-scope position with true roots", () => {
    const orphan = session("orphan", "/a", {
      parentSessionPath: "/sessions/missing-parent.jsonl",
      manualOrder: 0,
    });
    const root = session("root", "/a");
    const rows = sessionRows([orphan, root]);
    expect(rows.map((row) => row.session.id)).toEqual(["orphan", "root"]);
    expect(rows[0]).toMatchObject({ depth: 0, hasMissingParent: true });
  });
});
