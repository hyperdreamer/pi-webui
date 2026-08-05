import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionReorderRequest } from "../../shared/apiTypes.js";
import { assertSubmittedSessionsCurrent, SessionReorderDomainError, validateSessionReorder, type SessionReorderErrorKind } from "./sessionReorder.js";

function session(id: string, cwd: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    cwd,
    path: `/sessions/${id}.jsonl`,
    persisted: true,
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: "",
    ...patch,
  };
}

const rootRequest: SessionReorderRequest = {
  cwd: "/repo",
  scope: { kind: "root", cwd: "/repo" },
  pinned: false,
  catalogCwds: ["/repo", "/feature"],
  orderedSessions: [
    { id: "second", cwd: "/repo" },
    { id: "first", cwd: "/repo" },
  ],
};

describe("validateSessionReorder", () => {
  it("returns paths and normalized response for a complete coherent group", () => {
    expect(validateSessionReorder(
      { id: "first", cwd: "/repo" },
      rootRequest,
      [session("first", "/repo"), session("second", "/repo"), session("other", "/feature")],
    )).toEqual({
      sessionPaths: ["/sessions/second.jsonl", "/sessions/first.jsonl"],
      response: {
        orderedSessions: [
          { id: "second", cwd: "/repo", manualOrder: 0 },
          { id: "first", cwd: "/repo", manualOrder: 1 },
        ],
      },
    });
  });

  const staleCases: [SessionReorderErrorKind, SessionReorderRequest, SessionInfo[]][] = [
    ["invalid", { ...rootRequest, orderedSessions: [{ id: "second", cwd: "/repo" }] }, [session("first", "/repo"), session("second", "/repo")]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo", { pinned: true })]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo", { parentSessionPath: "/sessions/parent.jsonl" })]],
    ["conflict", { ...rootRequest, orderedSessions: [{ id: "second", cwd: "/feature" }, { id: "first", cwd: "/repo" }] }, [session("first", "/repo"), session("second", "/feature")]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo"), session("omitted", "/repo")]],
    ["conflict", { ...rootRequest, scope: { kind: "root", cwd: "/other" } }, [session("first", "/repo"), session("second", "/repo")]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo", { archived: true })]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo", { persisted: false })]],
    ["conflict", rootRequest, [session("first", "/repo", { persisted: false }), session("second", "/repo")]],
  ];

  it.each(staleCases)("reports %s for invalid or stale group state", (kind, request, catalog) => {
    try {
      validateSessionReorder({ id: "first", cwd: "/repo" }, request, catalog);
      throw new Error("Expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionReorderDomainError);
      if (!(error instanceof SessionReorderDomainError)) throw error;
      expect(error.kind).toBe(kind);
    }
  });

  it("reports not-found for an unresolved ordered identity", () => {
    expect(() => validateSessionReorder(
      { id: "first", cwd: "/repo" },
      rootRequest,
      [session("first", "/repo")],
    )).toThrow(expect.objectContaining({ kind: "not-found" }));
  });

  it("rejects distinct identities that resolve to one persisted path", () => {
    expect(() => validateSessionReorder(
      { id: "first", cwd: "/repo" },
      rootRequest,
      [
        session("first", "/repo"),
        { ...session("second", "/repo"), path: "/sessions/first.jsonl" },
      ],
    )).toThrow(expect.objectContaining({ kind: "invalid" }));
  });

  it("rejects duplicate submitted identities", () => {
    expect(() => validateSessionReorder(
      { id: "first", cwd: "/repo" },
      {
        ...rootRequest,
        orderedSessions: [
          { id: "first", cwd: "/repo" },
          { id: "first", cwd: "/repo" },
        ],
      },
      [session("first", "/repo")],
    )).toThrow(expect.objectContaining({ kind: "invalid" }));
  });

  it("accepts cross-workspace children only under the exact same parent", () => {
    const parentSessionPath = "/sessions/parent.jsonl";
    const request: SessionReorderRequest = {
      cwd: "/repo",
      scope: { kind: "children", parentSessionPath },
      pinned: false,
      catalogCwds: ["/repo", "/feature"],
      orderedSessions: [
        { id: "feature-child", cwd: "/feature" },
        { id: "main-child", cwd: "/repo" },
      ],
    };
    expect(validateSessionReorder(
      { id: "main-child", cwd: "/repo" },
      request,
      [
        session("main-child", "/repo", { parentSessionPath }),
        session("feature-child", "/feature", { parentSessionPath }),
      ],
    ).response.orderedSessions).toEqual([
      { id: "feature-child", cwd: "/feature", manualOrder: 0 },
      { id: "main-child", cwd: "/repo", manualOrder: 1 },
    ]);
  });

  it("post-write checks submitted members but allows a new unordered sibling", () => {
    expect(() => {
      assertSubmittedSessionsCurrent(
        { id: "first", cwd: "/repo" },
        rootRequest,
        [
          session("first", "/repo"),
          session("second", "/repo"),
          session("new", "/repo"),
        ],
      );
    }).not.toThrow();
    expect(() => {
      assertSubmittedSessionsCurrent(
        { id: "first", cwd: "/repo" },
        rootRequest,
        [
          session("first", "/repo"),
          session("second", "/repo", { pinned: true }),
        ],
      );
    }).toThrow(expect.objectContaining({ kind: "conflict" }));
  });
});
