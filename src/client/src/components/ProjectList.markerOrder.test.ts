// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../api";
import { ProjectList } from "./ProjectList";

const projects: Project[] = [
  { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "child", name: "Child", path: "/work/child", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "grandchild", name: "Grandchild", path: "/work/child/grandchild", createdAt: "2026-08-07T00:00:00.000Z" },
];

afterEach(() => {
  document.body.replaceChildren();
});

describe("ProjectList hierarchy marker order", () => {
  it("renders the tree marker before the disclosure control", async () => {
    const list = new ProjectList();
    list.projects = projects;
    Reflect.set(list, "expandedProjectIds", new Set(["root", "child"]));
    document.body.append(list);
    await list.updateComplete;

    const childName = list.shadowRoot
      ?.querySelector<HTMLElement>('.action-row[title="/work/child"] .workspace-primary');

    if (childName === null || childName === undefined) throw new Error("Expected the nested project name");
    expect([...childName.children].slice(0, 2).map((element) => element.className)).toEqual([
      "tree-marker",
      "session-group-toggle",
    ]);
  });
});
