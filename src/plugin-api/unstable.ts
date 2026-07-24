import type { TerminalCommandRun, TerminalCommandRunFilter, TerminalCommandRunHandle, Workspace, WorkspaceTerminalCommandInput } from "../plugin-api.js";

export interface UnstableRunTerminalCommandInput extends WorkspaceTerminalCommandInput {
  workspace: Workspace;
}

export interface UnstableTerminalCommandRunsRuntime {
  runCommand(input: UnstableRunTerminalCommandInput): Promise<TerminalCommandRunHandle>;
  listCommandRuns(filter?: TerminalCommandRunFilter): Promise<TerminalCommandRun[]>;
  getCommandRun(runId: string): Promise<TerminalCommandRun | undefined>;
  open(options?: { terminalId?: string | undefined }): void;
}

export interface UnstableRuntimeCapabilities {
  terminalCommandRuns: UnstableTerminalCommandRunsRuntime;
  openSettings?: (section?: string) => void;
}

export interface UnstablePluginRuntimeContext {
  piWebUiUnstable?: UnstableRuntimeCapabilities;
}

export interface UnstableWorkspacePanelContext {
  piWebUiUnstable?: Pick<UnstableRuntimeCapabilities, "terminalCommandRuns">;
}
