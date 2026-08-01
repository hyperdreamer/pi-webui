export interface AppAction {
  id: string;
  title: string;
  description?: string;
  shortcut?: string;
  group?: string;
  enabled?: boolean;
  /** When present on a disabled action, keep it visible and explain why it cannot run. */
  disabledReason?: string;
  /** Close the action palette after this action runs. Defaults to keeping it open. */
  closesActionPalette?: boolean;
  run: () => void | Promise<void>;
}

export function closesActionPaletteAfterRun(action: AppAction): boolean {
  return action.closesActionPalette === true;
}
