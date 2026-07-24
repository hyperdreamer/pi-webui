const ACTION_MENU_GAP_PX = 0;
const ACTION_MENU_MIN_USEFUL_HEIGHT_PX = 120;

interface ActionMenuRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface ActionMenuPanelStyleOptions {
  constrainTo?: "host" | "viewport";
}

export function actionMenuPanelStyle(target: EventTarget | null, options: ActionMenuPanelStyleOptions = {}): string {
  if (typeof HTMLElement === "undefined" || typeof window === "undefined" || !(target instanceof HTMLElement)) return "";
  const trigger = target.getBoundingClientRect();
  const bounds = options.constrainTo === "viewport" ? viewportBounds() : actionMenuBounds(target);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const leftBound = Math.max(0, bounds.left);
  const rightBound = Math.min(viewportWidth, bounds.right);
  const topBound = Math.max(0, bounds.top);
  const bottomBound = Math.min(viewportHeight, bounds.bottom);
  const triggerRight = Math.min(trigger.right, rightBound);
  const availableBelow = bottomBound - trigger.bottom - ACTION_MENU_GAP_PX;
  const availableAbove = trigger.top - topBound - ACTION_MENU_GAP_PX;
  const placement = availableBelow < ACTION_MENU_MIN_USEFUL_HEIGHT_PX && availableAbove > availableBelow
    ? [`bottom: ${px(viewportHeight - trigger.top + ACTION_MENU_GAP_PX)};`, `max-height: ${px(Math.max(0, availableAbove))};`]
    : [`top: ${px(trigger.bottom + ACTION_MENU_GAP_PX)};`, `max-height: ${px(Math.max(0, availableBelow))};`];

  return [
    ...placement,
    `right: ${px(Math.max(0, viewportWidth - triggerRight))};`,
    `max-width: ${px(Math.max(0, triggerRight - leftBound))};`,
  ].join(" ");
}

function actionMenuBounds(target: HTMLElement): ActionMenuRect {
  const root = target.getRootNode();
  if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot && root.host instanceof HTMLElement) return root.host.getBoundingClientRect();
  return viewportBounds();
}

function viewportBounds(): ActionMenuRect {
  return { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 };
}

function px(value: number): string {
  return `${String(Math.round(value))}px`;
}
