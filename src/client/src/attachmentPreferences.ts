import type { PromptAttachmentDelivery } from "../../shared/apiTypes";

const storageKey = "pi-webui:attachment-delivery";

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadAttachmentDelivery(storage = browserStorage()): PromptAttachmentDelivery {
  try {
    return storage?.getItem(storageKey) === "folder" ? "folder" : "inline";
  } catch {
    return "inline";
  }
}

export function saveAttachmentDelivery(mode: PromptAttachmentDelivery, storage = browserStorage()): void {
  try {
    storage?.setItem(storageKey, mode);
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}
