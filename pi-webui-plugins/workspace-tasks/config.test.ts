import { describe, expect, it } from "vitest";
import { isWorkspaceTaskId, type WorkspaceTask } from "../../src/shared/workspaceTasks";
import { suggestWorkspaceTaskId, validateAndNormalizeDraft, type WorkspaceTaskDraft } from "./config";

const baseTasks: WorkspaceTask[] = [
  { id: "build", title: "Build", command: "npm run build", confirm: false },
  { id: "test", title: "Test", command: "npm test", confirm: true },
];

const draft = (overrides: Partial<WorkspaceTaskDraft> = {}): WorkspaceTaskDraft => {
  const base: WorkspaceTaskDraft = {
    id: "verify",
    title: "Verify",
    command: "  set -e\nnpm test\n",
    description: " details ",
    group: " Quality ",
    confirm: false,
    global: false,
  };
  return Object.assign(base, overrides);
};

describe("workspace tasks editor config", () => {
  it.each([
    ["Build app", "build-app"],
    ["  $$$  ", "task"],
    ["2026 checks", "task-2026-checks"],
    ["Release...Candidate", "release-candidate"],
  ])("suggests a valid id for %s", (title, expected) => {
    expect(suggestWorkspaceTaskId(title)).toBe(expected);
  });

  it("uses the canonical task ID grammar", () => {
    expect(isWorkspaceTaskId("build.watch")).toBe(true);
    expect(isWorkspaceTaskId("Build Watch")).toBe(false);
  });

  it("normalizes ordinary fields while preserving the command string exactly", () => {
    expect(validateAndNormalizeDraft(draft(), baseTasks)).toEqual({
      ok: true,
      task: {
        id: "verify",
        title: "Verify",
        command: "  set -e\nnpm test\n",
        description: "details",
        group: "Quality",
        confirm: false,
      },
    });
  });

  it("omits blank optional fields and preserves confirmation", () => {
    expect(validateAndNormalizeDraft(draft({ description: " ", group: "\n", confirm: true }), baseTasks)).toEqual({
      ok: true,
      task: {
        id: "verify",
        title: "Verify",
        command: "  set -e\nnpm test\n",
        confirm: true,
      },
    });
  });

  it("reports required, canonical pattern, and duplicate errors", () => {
    expect(validateAndNormalizeDraft(draft({ id: "", title: "", command: " \n " }), baseTasks)).toEqual({
      ok: false,
      errors: {
        id: "ID is required.",
        title: "Title is required.",
        command: "Command script is required.",
      },
    });
    expect(validateAndNormalizeDraft(draft({ id: "Bad ID" }), baseTasks)).toMatchObject({
      ok: false,
      errors: { id: "ID must match ^[a-z][a-z0-9.-]*$." },
    });
    expect(validateAndNormalizeDraft(draft({ id: "test" }), baseTasks)).toMatchObject({
      ok: false,
      errors: { id: 'Task ID "test" already exists.' },
    });
    expect(validateAndNormalizeDraft(draft({ id: "test" }), baseTasks, 1)).toMatchObject({ ok: true });
  });
});
