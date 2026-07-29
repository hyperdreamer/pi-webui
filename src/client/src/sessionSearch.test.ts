import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import { filterSessionRows, hasSessionSearchQuery } from "./sessionSearch";
import type { SessionRow } from "./sessionTreeRows";

function row(id: string, patch: Partial<SessionInfo> = {}): SessionRow {
  const session: SessionInfo = {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: "2026-07-29T00:00:00.000Z",
    modified: "2026-07-29T00:00:00.000Z",
    messageCount: 1,
    firstMessage: `Message ${id}`,
    ...patch,
  };
  return { session, depth: 0, hasMissingParent: false, external: false, hasChildren: false, folded: false };
}

describe("hasSessionSearchQuery", () => {
  it("treats whitespace-only text as inactive", () => {
    expect(hasSessionSearchQuery("")).toBe(false);
    expect(hasSessionSearchQuery("   ")).toBe(false);
    expect(hasSessionSearchQuery("release")).toBe(true);
  });
});

const matchingCases: [string, string, Partial<SessionInfo>][] = [
  ["label", "release plan", { name: "Release plan" }],
  ["first message", "deploy", { firstMessage: "Deploy the documentation" }],
  ["session ID", "session-42", { id: "session-42" }],
  ["workspace path", "feature-b", { cwd: "/work/feature-b" }],
];

describe("filterSessionRows", () => {
  it.each(matchingCases)("matches a session %s without case sensitivity", (_field, query, patch) => {
    const candidate = row(patch.id ?? "candidate", patch);
    expect(filterSessionRows([candidate], query.toUpperCase())).toEqual([candidate]);
  });

  it("returns a new array for a blank query without changing the input", () => {
    const rows = [row("one"), row("two")];
    const result = filterSessionRows(rows, "  ");
    expect(result).toEqual(rows);
    expect(result).not.toBe(rows);
  });

  it("keeps each matching descendant's available ancestors in source order", () => {
    const parent = row("parent", { firstMessage: "Coordinate work" });
    const child = row("child", { firstMessage: "Deploy release", parentSessionPath: parent.session.path });
    expect(filterSessionRows([parent, child], "deploy")).toEqual([parent, child]);
  });

  it("stops safely when malformed parent links form a cycle", () => {
    const first = row("first", { firstMessage: "Needle" });
    const second = row("second", { parentSessionPath: first.session.path });
    first.session.parentSessionPath = second.session.path;
    expect(filterSessionRows([first, second], "needle")).toEqual([first, second]);
  });
});
