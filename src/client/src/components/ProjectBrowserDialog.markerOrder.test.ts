// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../api";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";

const projects: Project[] = [
  { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "child", name: "Child", path: "/work/child", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "grandchild", name: "Grandchild", path: "/work/child/grandchild", createdAt: "2026-08-07T00:00:00.000Z" },
];

afterEach(() => {
  document.body.replaceChildren();
});

describe("ProjectBrowserDialog hierarchy marker order", () => {
  it("renders the tree marker before the disclosure control", async () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    Reflect.set(dialog, "expandedProjectIds", new Set(["root", "child"]));
    document.body.append(dialog);
    await dialog.updateComplete;

    const childName = dialog.shadowRoot
      ?.querySelector<HTMLElement>('.project-row[title="/work/child"] .project-name');

    if (childName === null || childName === undefined) throw new Error("Expected the nested project name");
    expect([...childName.children].slice(0, 2).map((element) => element.className)).toEqual([
      "tree-marker",
      "session-group-toggle",
    ]);
  });
});
