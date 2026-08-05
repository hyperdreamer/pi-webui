import { describe, expect, it } from "vitest";
import { assignBuckets, bucketFor, isWithinProject } from "./projectUsageBuckets";

const scope = { projectPath: "/dev/pi-webui", liveCwds: ["/dev/pi-webui", "/dev/pi-webui/.worktrees/feature"] };

describe("isWithinProject", () => {
  it("matches the project path itself", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/pi-webui")).toBe(true);
  });

  it("matches a nested path", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/pi-webui/.worktrees/x")).toBe(true);
  });

  it("rejects a sibling sharing a name prefix", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/pi-webui-browser-fix")).toBe(false);
  });

  it("rejects an unrelated path", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/other")).toBe(false);
  });

  it("normalizes redundant segments", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/pi-webui/./sub")).toBe(true);
  });
});

describe("bucketFor", () => {
  it("assigns archived regardless of cwd liveness", () => {
    expect(bucketFor({ cwd: "/dev/pi-webui", archived: true }, scope)).toBe("archived");
  });

  it("assigns live for a listed workspace cwd", () => {
    expect(bucketFor({ cwd: "/dev/pi-webui/.worktrees/feature" }, scope)).toBe("live");
  });

  it("assigns retired for an in-project cwd that is not live", () => {
    expect(bucketFor({ cwd: "/dev/pi-webui/.worktrees/gone" }, scope)).toBe("retired");
  });

  it("returns undefined for a cwd outside the project", () => {
    expect(bucketFor({ cwd: "/dev/pi-webui-browser-fix" }, scope)).toBeUndefined();
  });

  it("returns undefined for an archived session whose cwd is outside the project path", () => {
    expect(bucketFor({ cwd: "/dev/elsewhere", archived: true }, scope)).toBeUndefined();
  });
});

describe("assignBuckets", () => {
  it("buckets each candidate and drops out-of-scope entries", () => {
    const result = assignBuckets([
      { sessionId: "a", path: "/store/a.jsonl", cwd: "/dev/pi-webui" },
      { sessionId: "b", path: "/store/b.jsonl", cwd: "/dev/pi-webui/.worktrees/gone" },
      { sessionId: "c", path: "/archive/c.jsonl", cwd: "/dev/pi-webui", archived: true },
      { sessionId: "d", path: "/store/d.jsonl", cwd: "/dev/pi-webui-browser-fix" },
    ], scope);

    expect(result).toEqual([
      { sessionId: "a", path: "/store/a.jsonl", cwd: "/dev/pi-webui", bucket: "live" },
      { sessionId: "b", path: "/store/b.jsonl", cwd: "/dev/pi-webui/.worktrees/gone", bucket: "retired" },
      { sessionId: "c", path: "/archive/c.jsonl", cwd: "/dev/pi-webui", bucket: "archived" },
    ]);
  });

  it("keeps the first occurrence of a duplicated session id", () => {
    const result = assignBuckets([
      { sessionId: "a", path: "/archive/a.jsonl", cwd: "/dev/pi-webui", archived: true },
      { sessionId: "a", path: "/store/a.jsonl", cwd: "/dev/pi-webui" },
    ], scope);

    expect(result).toHaveLength(1);
    expect(result[0]?.bucket).toBe("archived");
    expect(result[0]?.path).toBe("/archive/a.jsonl");
  });
});
