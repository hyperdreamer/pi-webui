import type { ActivityRailContext, PiWebUiPlugin } from "@hyperdreamer/pi-webui/plugin-api";
import { defineLearnedSkillsPanelElement, isLearnedSkillsPanelVisible, learnedSkillsBadge } from "./learnedSkillsPanelElement.js";
import type { LearnedSkillsWorkspaceState } from "./learnedSkillsData.js";

interface BundledLearnedSkillsAppState {
  readonly learnedSkills: LearnedSkillsWorkspaceState;
}

type BundledLearnedSkillsContext = ActivityRailContext & {
  readonly state: BundledLearnedSkillsAppState;
  readonly onRefreshLearnedSkills: () => void;
};

// Keep the core-owned state dependency at the public Activity Rail boundary.
function bundledLearnedSkillsContext(context: ActivityRailContext): BundledLearnedSkillsContext {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return context as BundledLearnedSkillsContext;
}

const plugin: PiWebUiPlugin = {
  apiVersion: 1,
  name: "Workspace Learned Skills",
  activate: ({ html, svg }) => {
    defineLearnedSkillsPanelElement();

    return {
      contributions: {
        activityRailItems: [
          {
            id: "workspace.learned-skills",
            title: "Learned Skills",
            icon: svg`
              <svg data-icon="lightbulb" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 18h6"></path>
                <path d="M10 22h4"></path>
                <path d="M15.09 14c.18-.69.66-1.22 1.19-1.75A6 6 0 1 0 7.72 12.25c.52.52 1 1.05 1.18 1.75"></path>
                <path d="M9 14h6"></path>
              </svg>
            `,
            order: 51,
            visible: (context) => {
              const learned = bundledLearnedSkillsContext(context);
              return context.workspaceScope !== undefined
                && isLearnedSkillsPanelVisible(learned.state.learnedSkills);
            },
            badge: (context) => learnedSkillsBadge(bundledLearnedSkillsContext(context).state.learnedSkills),
            render: (context) => {
              const learned = bundledLearnedSkillsContext(context);
              return html`<pi-webui-learned-skills-panel
                .context=${context}
                .learnedSkillsState=${learned.state.learnedSkills}
                .onRetry=${learned.onRefreshLearnedSkills}
              ></pi-webui-learned-skills-panel>`;
            },
          },
        ],
      },
    };
  },
};

export default plugin;
