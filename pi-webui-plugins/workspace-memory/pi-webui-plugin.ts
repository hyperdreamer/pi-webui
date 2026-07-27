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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.38-1 1.72V8h2a2 2 0 0 1 2 2v2h1.72a2 2 0 0 1 0 4H17v2a2 2 0 0 1-2 2h-2v1.72a2 2 0 0 1-4 0V20H7a2 2 0 0 1-2-2v-2H3.28a2 2 0 0 1 0-4H5v-2a2 2 0 0 1 2-2h2V5.72A2 2 0 0 1 12 2Z"></path>
                <circle cx="8" cy="14" r="1"></circle>
                <circle cx="16" cy="14" r="1"></circle>
                <path d="M12 17v2"></path>
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
