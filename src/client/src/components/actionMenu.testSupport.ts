/** Invoke a list's document-click listener with a click outside its action menu. */
export function clickOutsideActionMenu(component: EventTarget): void {
  dispatchActionMenuDocumentClick(component, [component]);
}

/** Invoke a list's document-click listener with a composed event path. */
export function dispatchActionMenuDocumentClick(component: EventTarget, path: EventTarget[]): void {
  actionMenuDocumentClickListener(component)(actionMenuDocumentClickEvent(path));
}

/** Create a composed click event for action-menu listener tests. */
export function actionMenuDocumentClickEvent(path: EventTarget[]): Event {
  const event = new Event("click", { cancelable: true });
  Object.defineProperty(event, "composedPath", { value: () => path });
  return event;
}

/** Retrieve a list's document-click listener for registration assertions. */
export function actionMenuDocumentClickListener(component: EventTarget): (event: Event) => void {
  const listener: unknown = Reflect.get(component, "onDocumentClick");
  if (!isEventListener(listener)) throw new Error("Action menu document click listener is unavailable");
  return listener;
}

function isEventListener(value: unknown): value is (event: Event) => void {
  return typeof value === "function";
}
