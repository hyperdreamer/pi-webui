const draftStoragePrefix = "pi-webui:prompt-draft:";

function draftStorageKey(sessionId: string): string {
  return `${draftStoragePrefix}${sessionId}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadDraft(sessionId: string, storage = browserStorage()): string {
  try {
    return storage?.getItem(draftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(sessionId: string, draft: string, storage = browserStorage()): void {
  try {
    if (draft) storage?.setItem(draftStorageKey(sessionId), draft);
    else storage?.removeItem(draftStorageKey(sessionId));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function clearDraft(sessionId: string, storage = browserStorage()): void {
  try {
    storage?.removeItem(draftStorageKey(sessionId));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function moveDraft(fromSessionId: string, toSessionId: string, storage = browserStorage()): void {
  const draft = loadDraft(fromSessionId, storage);
  if (draft === "") return;
  saveDraft(toSessionId, draft, storage);
  clearDraft(fromSessionId, storage);
}
