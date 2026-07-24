import type { AppAction } from "./actions";
import type { PiWebUiShortcutConfig } from "./api";
import { resolveShortcutBindings } from "./keyboardShortcuts";

export function applyShortcutPreferences(actions: AppAction[], shortcuts: PiWebUiShortcutConfig | undefined): AppAction[] {
  if (shortcuts === undefined) return actions;
  return actions.map((action) => applyShortcutPreference(action, shortcuts));
}

export function applyActiveShortcutPreferences(actions: AppAction[], shortcuts: PiWebUiShortcutConfig | undefined): AppAction[] {
  const activeShortcutActionIds = new Set(resolveShortcutBindings(actions, shortcuts, { enabledOnly: true })
    .filter((binding) => binding.active)
    .map((binding) => binding.action.id));
  return applyShortcutPreferences(actions, shortcuts).map((action) => action.shortcut !== undefined && !activeShortcutActionIds.has(action.id) ? withoutShortcut(action) : action);
}

export function applyShortcutPreference(action: AppAction, shortcuts: PiWebUiShortcutConfig): AppAction {
  if (!Object.hasOwn(shortcuts, action.id)) return action;
  const shortcut = shortcuts[action.id];
  if (shortcut === undefined) return action;
  if (shortcut === null) return withoutShortcut(action);
  return { ...action, shortcut };
}

function withoutShortcut(action: AppAction): AppAction {
  const copy = { ...action };
  delete copy.shortcut;
  return copy;
}
