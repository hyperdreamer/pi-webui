import type { ActivityRailContext, PiWebUiPlugin } from "@hyperdreamer/pi-webui/plugin-api";
import { defineMemoryPanelElement, isMemoryPanelVisible, memoryBadge } from "./memoryPanelElement.js";

interface BundledMemoryAppState {
  readonly memory: import("./memoryData.js").MemoryWorkspaceState;
}

type BundledMemoryContext = ActivityRailContext & {
  readonly state: BundledMemoryAppState;
  readonly onRefreshMemory: () => void;
};

// The core supplies a context compatible with BundledMemoryContext;
// this is the narrowest boundary type without importing core internals.
function bundledMemoryContext(context: ActivityRailContext): BundledMemoryContext {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return context as BundledMemoryContext;
}

const plugin: PiWebUiPlugin = {
  apiVersion: 1,
  name: "Workspace Memory",
  activate: ({ html, svg }) => {
    defineMemoryPanelElement();

    return {
      contributions: {
        activityRailItems: [
          {
            id: "workspace.memory",
            title: "Memory",
            icon: svg`
              <svg data-icon="brain" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 18V5"></path>
                <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"></path>
                <path d="M17.6 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.6 1.5"></path>
                <path d="M17.6 17.5A3 3 0 1 1 12 19a3 3 0 1 1-5.6-1.5"></path>
                <path d="M17.6 6.5a3 3 0 0 1 1.4 5.5 3 3 0 0 1-1.4 5.5"></path>
                <path d="M6.4 17.5A3 3 0 0 1 5 12a3 3 0 0 1 1.4-5.5"></path>
              </svg>
            `,
            order: 50,
            visible: (context) => context.workspaceScope !== undefined
              && isMemoryPanelVisible(bundledMemoryContext(context).state.memory),
            badge: (context) => memoryBadge(bundledMemoryContext(context).state.memory),
            render: (context) => {
              const memory = bundledMemoryContext(context);
              return html`<pi-webui-memory-panel .context=${context} .memoryState=${memory.state.memory} .onRetry=${memory.onRefreshMemory}></pi-webui-memory-panel>`;
            },
          },
        ],
      },
    };
  },
};

export default plugin;
