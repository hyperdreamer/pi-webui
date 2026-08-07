import { describe, expect, it } from "vitest";
import { isDirectoryAncestor, projectDescendantIds } from "./projectAncestry";

describe("isDirectoryAncestor", () => {
  it.each([
    ["direct parent", "/work", "/work/app", true],
    ["nested descendant", "/a", "/a/b/c", true],
    ["sibling", "/work/app", "/work/other", false],
    ["prefix that is not a directory boundary", "/work/app", "/work/application", false],
    ["prefix without separator", "/work", "/workspace", false],
    ["equal paths", "/work/app", "/work/app", false],
    ["trailing separator on parent", "/work/", "/work/app", true],
    ["trailing separator on child", "/work", "/work/app/", true],
    ["child equal to parent after normalization", "/work/", "/work", false],
    ["windows separators", "C:\\work", "C:\\work\\app", true],
    ["posix filesystem root", "/", "/work", true],
    ["windows drive root", "C:\\", "C:\\work", true],
    ["drive-relative path is not a child", "C:", "C:work", false],
    ["relative child under root", "/", "work", false],
    ["case sensitivity", "/Work", "/work/app", false],
  ])("%s", (_label, parentPath, childPath, expected) => {
    expect(isDirectoryAncestor(parentPath, childPath)).toBe(expected);
  });
});

describe("projectDescendantIds", () => {
  const projects = [
    { id: "root", path: "/work" },
    { id: "child-one", path: "/work/app1" },
    { id: "child-two", path: "/work/app2" },
    { id: "grandchild", path: "/work/app1/nested" },
    { id: "unrelated", path: "/other" },
    { id: "near-miss", path: "/workspace" },
  ];

  it("returns descendants at every depth", () => {
    expect(new Set(projectDescendantIds(projects, "root"))).toEqual(
      new Set(["child-one", "child-two", "grandchild"]),
    );
  });

  it("excludes the target itself", () => {
    expect(projectDescendantIds(projects, "root")).not.toContain("root");
  });

  it("excludes unrelated projects and directory-boundary near misses", () => {
    const descendants = projectDescendantIds(projects, "root");
    expect(descendants).not.toContain("unrelated");
    expect(descendants).not.toContain("near-miss");
  });

  it("returns an empty array for a leaf", () => {
    expect(projectDescendantIds(projects, "grandchild")).toEqual([]);
  });

  it("returns an empty array for an unknown target", () => {
    expect(projectDescendantIds(projects, "missing")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const snapshot = structuredClone(projects);
    projectDescendantIds(projects, "root");
    expect(projects).toEqual(snapshot);
  });
});
