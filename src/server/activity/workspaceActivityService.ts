import { isSessionActive, isWorkspaceActivityActive } from "../../shared/activity.js";
import type { RealtimeEvent, SessionActivity, SessionStatus, TerminalInfo, WorkspaceActivity, WorkspaceActivityResponse } from "../../shared/apiTypes.js";

export interface WorkspaceActivityPublisher {
  publishRealtime(event: RealtimeEvent): void;
}

interface SessionRecord {
  cwd: string;
  status?: SessionStatus;
  activity?: SessionActivity;
}

interface TerminalRecord {
  cwd: string;
}

export class WorkspaceActivityService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(private readonly publisher?: WorkspaceActivityPublisher) {}

  applySessionStatus(cwd: string, status: SessionStatus): void {
    const previousCwd = this.sessions.get(status.sessionId)?.cwd;
    const record = this.sessions.get(status.sessionId) ?? { cwd };
    record.cwd = cwd;
    record.status = status;
    if (!isSessionActive(status) && record.activity?.phase === "active") delete record.activity;
    this.sessions.set(status.sessionId, record);
    this.pruneIdleSession(status.sessionId);
    this.publishChangedCwds(previousCwd, cwd);
  }

  applySessionActivity(cwd: string, activity: SessionActivity): void {
    const previousCwd = this.sessions.get(activity.sessionId)?.cwd;
    const record = this.sessions.get(activity.sessionId) ?? { cwd };
    record.cwd = cwd;
    record.activity = activity;
    this.sessions.set(activity.sessionId, record);
    this.pruneIdleSession(activity.sessionId);
    this.publishChangedCwds(previousCwd, cwd);
  }

  removeSession(sessionId: string, cwd?: string): void {
    const previousCwd = this.sessions.get(sessionId)?.cwd ?? cwd;
    this.sessions.delete(sessionId);
    this.publishCwd(previousCwd);
  }

  reconcileSessionActivity(cwd: string, sessionIds: Iterable<string>): void {
    const knownSessionIds = new Set(sessionIds);
    let changed = false;
    for (const [sessionId, record] of this.sessions.entries()) {
      if (record.cwd !== cwd || knownSessionIds.has(sessionId)) continue;
      this.sessions.delete(sessionId);
      changed = true;
    }
    if (changed) this.publishCwd(cwd);
  }

  updateTerminal(terminal: Pick<TerminalInfo, "id" | "cwd" | "exited">): void {
    const previousCwd = this.terminals.get(terminal.id)?.cwd;
    if (terminal.exited) this.terminals.delete(terminal.id);
    else this.terminals.set(terminal.id, { cwd: terminal.cwd });
    this.publishChangedCwds(previousCwd, terminal.cwd);
  }

  removeTerminal(terminalId: string, cwd?: string): void {
    const previousCwd = this.terminals.get(terminalId)?.cwd ?? cwd;
    this.terminals.delete(terminalId);
    this.publishCwd(previousCwd);
  }

  snapshot(): WorkspaceActivityResponse {
    return {
      workspaces: this.activeCwds().map((cwd) => this.summaryForCwd(cwd)).filter(isWorkspaceActivityActive),
      generatedAt: new Date().toISOString(),
    };
  }

  private pruneIdleSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record !== undefined && !isSessionActive(record.status, record.activity)) this.sessions.delete(sessionId);
  }

  private publishChangedCwds(previousCwd: string | undefined, cwd: string): void {
    this.publishCwd(previousCwd);
    if (previousCwd !== cwd) this.publishCwd(cwd);
  }

  private publishCwd(cwd: string | undefined): void {
    if (cwd === undefined || cwd === "") return;
    this.publisher?.publishRealtime({ type: "workspace.activity", activity: this.summaryForCwd(cwd) });
  }

  private activeCwds(): string[] {
    const cwds = new Set<string>();
    for (const record of this.sessions.values()) {
      if (isSessionActive(record.status, record.activity)) cwds.add(record.cwd);
    }
    for (const record of this.terminals.values()) cwds.add(record.cwd);
    return [...cwds].sort((a, b) => a.localeCompare(b));
  }

  private summaryForCwd(cwd: string): WorkspaceActivity {
    return {
      cwd,
      hasSessionActivity: [...this.sessions.values()].some((record) => record.cwd === cwd && isSessionActive(record.status, record.activity)),
      hasTerminalActivity: [...this.terminals.values()].some((terminal) => terminal.cwd === cwd),
      updatedAt: new Date().toISOString(),
    };
  }
}
