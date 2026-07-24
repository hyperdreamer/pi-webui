import { terminalsApi as defaultApi, type RunTerminalCommandInput, type TerminalCommandRun, type TerminalCommandRunFilter, type Workspace } from "../api";
import type { TerminalCommandRunsInternalRuntime } from "../plugins/types";

type TimerId = ReturnType<typeof globalThis.setTimeout>;
type SetTimer = (handler: () => void, timeout: number) => TimerId;
type ClearTimer = (id: TimerId) => void;

export interface TerminalCommandRunsRuntimeDependencies {
  api?: Pick<typeof defaultApi, "runTerminalCommand" | "listCommandRuns" | "getCommandRun">;
  openTerminal: (workspace: Workspace | undefined, options?: { terminalId?: string | undefined }) => void | Promise<void>;
  pollIntervalMs?: number;
  setTimeout?: SetTimer;
  clearTimeout?: ClearTimer;
}

export function createTerminalCommandRunsRuntime(origin: string, deps: TerminalCommandRunsRuntimeDependencies): TerminalCommandRunsInternalRuntime {
  const api = deps.api ?? defaultApi;
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;
  const setTimer = deps.setTimeout ?? defaultSetTimeout();
  const clearTimer = deps.clearTimeout ?? defaultClearTimeout();

  return {
    async runCommand(input: RunTerminalCommandInput) {
      const run = await api.runTerminalCommand(origin, input);
      if (input.open === true) void deps.openTerminal(input.workspace, { terminalId: run.terminalId });
      return { run, completed: waitForCommandRunCompletion(run, api, pollIntervalMs, setTimer, clearTimer) };
    },
    listCommandRuns: (filter?: TerminalCommandRunFilter) => api.listCommandRuns(filter),
    getCommandRun: (runId: string) => api.getCommandRun(runId),
    open: (options?: { terminalId?: string | undefined }) => { void deps.openTerminal(undefined, options); },
  };
}

function waitForCommandRunCompletion(
  initialRun: TerminalCommandRun,
  api: Pick<typeof defaultApi, "getCommandRun">,
  pollIntervalMs: number,
  setTimer: SetTimer,
  clearTimer: ClearTimer,
): Promise<TerminalCommandRun> {
  if (isTerminalCommandRunFinal(initialRun)) return Promise.resolve(initialRun);
  return new Promise((resolve, reject) => {
    let timer: TimerId | undefined;
    let settled = false;

    const finish = (result: TerminalCommandRun) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const poll = () => {
      void api.getCommandRun(initialRun.id).then((run) => {
        if (run !== undefined && isTerminalCommandRunFinal(run)) {
          finish(run);
          return;
        }
        timer = setTimer(poll, pollIntervalMs);
      }).catch(fail);
    };

    timer = setTimer(poll, pollIntervalMs);
  });
}

function isTerminalCommandRunFinal(run: TerminalCommandRun): boolean {
  return run.status === "succeeded" || run.status === "failed";
}

function defaultSetTimeout(): SetTimer {
  return (handler, timeout) => globalThis.setTimeout(handler, timeout);
}

function defaultClearTimeout(): ClearTimer {
  return (id) => { globalThis.clearTimeout(id); };
}
