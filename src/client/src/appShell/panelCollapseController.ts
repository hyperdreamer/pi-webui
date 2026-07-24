import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { AppState } from "../appState";

export class PanelCollapseController implements ReactiveController {
  navigationPanelCollapsed = false;
  workspacePanelCollapsed = false;

  hostConnected(): void {
    return;
  }

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  toggleNavigationPanel(): void {
    this.navigationPanelCollapsed = !this.navigationPanelCollapsed;
    this.host.requestUpdate();
  }

  toggleWorkspacePanel(): void {
    this.workspacePanelCollapsed = !this.workspacePanelCollapsed;
    this.host.requestUpdate();
  }

  expandNavigationPanel(): void {
    if (!this.navigationPanelCollapsed) return;
    this.navigationPanelCollapsed = false;
    this.host.requestUpdate();
  }

  expandWorkspacePanel(): void {
    if (!this.workspacePanelCollapsed) return;
    this.workspacePanelCollapsed = false;
    this.host.requestUpdate();
  }

  shellClass(mainView: AppState["mainView"]): string {
    return [
      "shell",
      mainViewClass(mainView),
      ...(this.navigationPanelCollapsed ? ["navigation-panel-collapsed"] : []),
      ...(this.workspacePanelCollapsed ? ["workspace-panel-collapsed"] : []),
    ].join(" ");
  }
}

export function mainViewClass(mainView: AppState["mainView"]): "navigation-view" | "chat-view" | "workspace-view" {
  if (mainView === "navigation") return "navigation-view";
  if (mainView === "chat") return "chat-view";
  return "workspace-view";
}
