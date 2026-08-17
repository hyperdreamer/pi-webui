import type { PiWebUiPlugin, WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import { TASKS_CONFIG_PATH, type WorkspaceTask, type WorkspaceTaskRef, type WorkspaceTaskScope } from "@pi-webui/workspace-tasks-domain";
import { defineTasksPanelElement, tasksPanelBadge } from "./tasksPanelElement.js";

interface BundledWorkspaceTaskCatalogState {
  readonly kind: "loading" | "loaded" | "missing" | "invalid" | "unavailable" | "error";
  readonly config?: { readonly version: 1; readonly tasks: readonly Readonly<WorkspaceTask>[] };
  readonly message?: string;
  readonly hint?: string;
  readonly detail?: string;
  readonly refreshing?: boolean;
  readonly refreshError?: string;
}

interface BundledWorkspaceTasksState {
  readonly workspace: BundledWorkspaceTaskCatalogState;
  readonly global: BundledWorkspaceTaskCatalogState;
  readonly move?: { readonly kind: "partial" | "unknown-outcome" | "conflict"; readonly message: string; readonly retryAllowed: boolean };
  readonly mutationGate?: { readonly scopes: readonly WorkspaceTaskScope[]; readonly message: string };
}

interface BundledWorkspaceTasksActions {
  create(scope: WorkspaceTaskScope, task: WorkspaceTask): Promise<void>;
  update(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>;
  remove(ref: WorkspaceTaskRef): Promise<void>;
  move(ref: WorkspaceTaskRef, destinationTask: WorkspaceTask): Promise<void>;
  retryMove(): Promise<void>;
  refresh(): Promise<void>;
}

interface BundledWorkspaceTasksBridge {
  readonly state: BundledWorkspaceTasksState;
  readonly actions: BundledWorkspaceTasksActions;
}

type BundledWorkspaceTasksContext = WorkspacePanelContext & {
  readonly workspaceTasks: BundledWorkspaceTasksBridge;
};

function bundledWorkspaceTasksContext(context: WorkspacePanelContext): BundledWorkspaceTasksContext {
  // The core adds this identity-scoped bridge only for the bundled contribution.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return context as BundledWorkspaceTasksContext;
}

const plugin: PiWebUiPlugin = {
  apiVersion: 1,
  name: "Workspace Tasks",
  activate: ({ pluginId, html, svg }) => {
    defineTasksPanelElement();

    return {
      contributions: {
        actions: [
          {
            id: "workspace.open-tasks",
            title: "Open Workspace Tasks",
            description: `Open the workspace Tasks tab. Configure tasks in ${TASKS_CONFIG_PATH}.`,
            group: "Workspace",
            closesActionPalette: true,
            enabled: (context) => context.state.selectedWorkspace !== undefined,
            run: (context) => {
              if (context.state.selectedWorkspace === undefined) return;
              context.selectWorkspaceTool(`${pluginId}:workspace.tasks`);
            },
          },
        ],
        workspacePanels: [
          {
            id: "workspace.tasks",
            title: "Tasks",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6h11"></path>
                <path d="M9 12h11"></path>
                <path d="M9 18h11"></path>
                <path d="m4 6 .8 .8L6.5 5"></path>
                <path d="m4 12 .8 .8 1.7-1.8"></path>
                <path d="m4 18 .8 .8 1.7-1.8"></path>
              </svg>
            `,
            order: 40,
            badge: (context) => tasksPanelBadge(context),
            render: (context) => {
              const tasks = bundledWorkspaceTasksContext(context).workspaceTasks;
              return html`<pi-webui-workspace-tasks-panel
                .context=${context}
                .workspaceTasksState=${tasks.state}
                .workspaceTasksActions=${tasks.actions}
              ></pi-webui-workspace-tasks-panel>`;
            },
          },
        ],
      },
    };
  },
};

export default plugin;
