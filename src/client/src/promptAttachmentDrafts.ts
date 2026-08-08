import type { CapturedAttachment } from "./promptAttachmentCapture";

/** A captured attachment plus the id the chip UI uses to address it. */
export type PendingAttachment = CapturedAttachment & { id: string };

/** One session's unsent composer attachments and its last read failure. */
export interface PromptAttachmentDraft {
  attachments: readonly PendingAttachment[];
  error?: string;
}

/**
 * In-memory attachment drafts, keyed by `machineSessionKey`.
 *
 * Deliberately not persisted. A base64 photo routinely exceeds the ~5 MiB
 * `localStorage` origin quota, and `saveDraft` swallows quota errors, so
 * persisting here would fail silently at capture time and look saved. Losing
 * drafts at reload is predictable; losing them invisibly at capture is not.
 *
 * This store also owns attachment id allocation. A per-component counter
 * restarts at zero on every mount, so a remounted editor that restored a draft
 * containing `attachment-1` would mint that id a second time, and removal
 * filters by id, so one remove click would delete two chips.
 */
export class PromptAttachmentDraftStore {
  private readonly drafts = new Map<string, PromptAttachmentDraft>();
  private attachmentSeq = 0;

  read(key: string): PromptAttachmentDraft {
    const draft = this.drafts.get(key);
    if (draft === undefined) return { attachments: [] };
    return {
      attachments: [...draft.attachments],
      ...(draft.error === undefined ? {} : { error: draft.error }),
    };
  }

  write(key: string, draft: PromptAttachmentDraft): void {
    // An empty draft holds no user intent, so drop the entry and release bytes.
    // An error-only draft still does, and must survive to stay visible.
    if (draft.attachments.length === 0 && draft.error === undefined) {
      this.drafts.delete(key);
      return;
    }
    this.drafts.set(key, {
      attachments: [...draft.attachments],
      ...(draft.error === undefined ? {} : { error: draft.error }),
    });
  }

  clear(key: string): void {
    this.drafts.delete(key);
  }

  /**
   * Re-key a draft, used when a pending start resolves to its real session id.
   * An absent source clears the destination: the destination key is newly in use
   * and must not inherit an unrelated draft left under the same id.
   */
  move(fromKey: string, toKey: string): void {
    const draft = this.drafts.get(fromKey);
    if (draft === undefined) {
      this.drafts.delete(toKey);
      return;
    }
    this.drafts.set(toKey, draft);
    this.drafts.delete(fromKey);
  }

  nextAttachmentId(): string {
    this.attachmentSeq += 1;
    return `attachment-${String(this.attachmentSeq)}`;
  }

  /** Whether a key currently holds an entry. Exposed for draft-lifecycle tests. */
  hasEntry(key: string): boolean {
    return this.drafts.has(key);
  }
}

/** Shared store for the app's lifetime; drafts end when the page unloads. */
export const promptAttachmentDrafts = new PromptAttachmentDraftStore();
