import { activityApi as defaultApi, type WorkspaceActivity, type WorkspaceActivityResponse } from "../api";
import { isWorkspaceActivityActive } from "../../../shared/activity";
import { selectedMachineId, type GetState, type SetState } from "./types";
import { TrailingRefreshCoordinator } from "./trailingRefreshCoordinator";

export interface ActivityControllerDependencies {
  api?: Pick<typeof defaultApi, "workspaceActivity">;
  onActivityApplied?: (machineId: string) => void;
}

export class ActivityController {
  private readonly api: Pick<typeof defaultApi, "workspaceActivity">;
  private readonly onActivityApplied: ((machineId: string) => void) | undefined;
  private readonly refreshes = new TrailingRefreshCoordinator<string>();

  constructor(private readonly getState: GetState, private readonly setState: SetState, deps: ActivityControllerDependencies = {}) {
    this.api = deps.api ?? defaultApi;
    this.onActivityApplied = deps.onActivityApplied;
  }

  refresh(machineId = selectedMachineId(this.getState())): Promise<void> {
    return this.refreshes.request(machineId, async () => {
      this.applyMachineActivitySnapshot(machineId, indexWorkspaceActivities(await this.api.workspaceActivity(machineId)));
    });
  }

  applyWorkspaceActivity(activity: WorkspaceActivity, machineId = selectedMachineId(this.getState())): void {
    const state = this.getState();
    const isSelectedMachine = selectedMachineId(state) === machineId;
    const currentMachineActivities = state.machineActivities[machineId] ?? (isSelectedMachine ? state.workspaceActivities : {});
    const nextMachineActivities = applyWorkspaceActivityToMap(currentMachineActivities, activity);
    this.setState({
      machineActivities: { ...state.machineActivities, [machineId]: nextMachineActivities },
      ...(isSelectedMachine ? { workspaceActivities: nextMachineActivities } : {}),
    });
    this.onActivityApplied?.(machineId);
  }

  private applyMachineActivitySnapshot(machineId: string, activities: Record<string, WorkspaceActivity>): void {
    const state = this.getState();
    this.setState({
      machineActivities: { ...state.machineActivities, [machineId]: activities },
      ...(selectedMachineId(state) === machineId ? { workspaceActivities: activities } : {}),
    });
    this.onActivityApplied?.(machineId);
  }
}

export function indexWorkspaceActivities(snapshot: WorkspaceActivityResponse): Record<string, WorkspaceActivity> {
  const activities: Record<string, WorkspaceActivity> = {};
  for (const activity of snapshot.workspaces) {
    if (isWorkspaceActivityActive(activity)) activities[activity.cwd] = activity;
  }
  return activities;
}

export function applyWorkspaceActivityToMap(current: Record<string, WorkspaceActivity>, activity: WorkspaceActivity): Record<string, WorkspaceActivity> {
  const next = { ...current };
  if (isWorkspaceActivityActive(activity)) {
    next[activity.cwd] = activity;
    return next;
  }
  return Object.fromEntries(Object.entries(next).filter(([cwd]) => cwd !== activity.cwd));
}
