import type { GitFileState, GitStatusFile } from "./api";

export type GitUpdateChangeScope = "staged" | "unstaged";

export interface GitUpdateChange {
  id: string;
  path: string;
  oldPath?: string;
  scope: GitUpdateChangeScope;
  state: GitFileState;
}

export interface GitUpdateChanges {
  staged: GitUpdateChange[];
  unstaged: GitUpdateChange[];
}

export function gitUpdateChanges(files: readonly GitStatusFile[]): GitUpdateChanges {
  const staged: GitUpdateChange[] = [];
  const unstaged: GitUpdateChange[] = [];

  for (const file of files) {
    if (isStagedState(file.index)) staged.push(changeFor(file, "staged", file.index));
    if (isUnstagedState(file.workingTree)) unstaged.push(changeFor(file, "unstaged", file.workingTree));
  }

  return { staged, unstaged };
}

export function gitUpdateManagerChangeCount(files: readonly GitStatusFile[]): number {
  const changes = gitUpdateChanges(files);
  return new Set([...changes.staged, ...changes.unstaged].map((change) => change.path)).size;
}

export function gitStatusIndicator(state: GitFileState): string {
  switch (state) {
    case "modified": return "M";
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    case "untracked": return "?";
    case "conflicted": return "U";
    case "ignored": return "!";
    case "unmodified": return "";
  }
}

export function gitStatusLabel(state: GitFileState): string {
  switch (state) {
    case "modified": return "Modified";
    case "added": return "Added";
    case "deleted": return "Deleted";
    case "renamed": return "Renamed";
    case "copied": return "Copied";
    case "untracked": return "Untracked";
    case "conflicted": return "Conflicted";
    case "ignored": return "Ignored";
    case "unmodified": return "Unmodified";
  }
}

export function gitUpdateChangePath(change: Pick<GitUpdateChange, "path" | "oldPath">): string {
  return change.oldPath === undefined ? change.path : `${change.oldPath} → ${change.path}`;
}

function changeFor(file: GitStatusFile, scope: GitUpdateChangeScope, state: GitFileState): GitUpdateChange {
  return {
    id: `${scope}:${file.path}`,
    path: file.path,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    scope,
    state,
  };
}

function isStagedState(state: GitFileState): boolean {
  return state !== "unmodified" && state !== "untracked" && state !== "ignored" && state !== "conflicted";
}

function isUnstagedState(state: GitFileState): boolean {
  return state !== "unmodified" && state !== "ignored";
}
