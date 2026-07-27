import type { PiWebUiPlugin } from "@hyperdreamer/pi-webui/plugin-api";
import { defineMemoryPanelElement } from "./memoryPanelElement.js";

const plugin: PiWebUiPlugin = {
  apiVersion: 1,
  name: "Workspace Memory",
  activate: ({ html, svg }) => {
    defineMemoryPanelElement();

    return {
      contributions: {
        workspacePanels: [
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
            render: (context) => html`<pi-webui-memory-panel .context=${context}></pi-webui-memory-panel>`,
          },
        ],
      },
    };
  },
};

export default plugin;
