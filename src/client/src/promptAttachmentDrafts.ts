import type { CapturedAttachment } from "./promptAttachmentCapture";

/** A captured attachment plus the id the chip UI uses to address it. */
export type PendingAttachment = CapturedAttachment & { id: string };

/** One session's unsent composer attachments and its last read failure. */
export interface PromptAttachmentDraft {
  attachments: readonly PendingAttachment[];
  error?: string;
}

/**
 * A live scope handle held by an editor. The store retargets the handle when a
 * session id migrates and invalidates it when the draft is cleared, so delayed
 * component work cannot write through an obsolete raw key.
 */
export interface PromptAttachmentDraftScope {
  currentKey(): string | undefined;
  read(): PromptAttachmentDraft;
  write(draft: PromptAttachmentDraft): void;
  clear(): void;
  beginCapture(): PromptAttachmentCapture;
}

/** A deferred capture that follows its originating scope lineage. */
export interface PromptAttachmentCapture {
  complete(
    attachments: readonly CapturedAttachment[],
    error: string | undefined,
  ): PromptAttachmentDraft | undefined;
}

interface DraftScopeState {
  currentKey: string;
  valid: boolean;
  draft: PromptAttachmentDraft | undefined;
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
  private readonly scopes = new Map<string, DraftScopeState>();
  private readonly migratedScopes = new Map<string, DraftScopeState>();
  private attachmentSeq = 0;

  read(key: string): PromptAttachmentDraft {
    const scope = this.scopes.get(key);
    return scope === undefined ? { attachments: [] } : this.readScope(scope);
  }

  write(key: string, draft: PromptAttachmentDraft): void {
    const scope = this.findScopeState(key) ?? this.createScopeState(key);
    this.writeScope(scope, draft);
  }

  /** Open the live lineage for a session key, creating one for new user work. */
  openScope(key: string): PromptAttachmentDraftScope {
    return this.scopeHandle(this.findScopeState(key) ?? this.createScopeState(key));
  }

  /** Find an existing lineage without claiming a cleared key for stale work. */
  findScope(key: string): PromptAttachmentDraftScope | undefined {
    const scope = this.findScopeState(key);
    return scope === undefined ? undefined : this.scopeHandle(scope);
  }

  clear(key: string): void {
    const scope = this.findScopeState(key);
    if (scope !== undefined) this.invalidateScope(scope);
  }

  /**
   * Re-key a draft to a new key, used when a pending start resolves to its real
   * session id. Handles already issued for the source keep pointing at the
   * same scope, now under the destination key.
   *
   * An absent source clears the destination: the destination key is newly in
   * use and must not inherit an unrelated draft left under the same id.
   */
  move(fromKey: string, toKey: string): void {
    // Preserve the existing same-key behavior: moving a key onto itself drops
    // its current snapshot. This path has no current production caller.
    if (fromKey === toKey) {
      const scope = this.findScopeState(fromKey);
      if (scope !== undefined) scope.draft = undefined;
      return;
    }

    const source = this.findScopeState(fromKey);
    const destination = this.findScopeState(toKey);
    if (source === undefined) {
      if (destination !== undefined) this.invalidateScope(destination);
      return;
    }
    if (destination !== undefined && destination !== source) this.invalidateScope(destination);

    this.removeCanonicalMapping(source);
    source.currentKey = toKey;
    source.valid = true;
    this.scopes.set(toKey, source);
    this.migratedScopes.set(fromKey, source);
  }

  nextAttachmentId(): string {
    this.attachmentSeq += 1;
    return `attachment-${String(this.attachmentSeq)}`;
  }

  /** Whether a canonical key currently holds an entry. Exposed for tests. */
  hasEntry(key: string): boolean {
    return this.scopes.get(key)?.draft !== undefined;
  }

  private createScopeState(key: string): DraftScopeState {
    const scope: DraftScopeState = { currentKey: key, valid: true, draft: undefined };
    this.scopes.set(key, scope);
    this.migratedScopes.delete(key);
    return scope;
  }

  private findScopeState(key: string): DraftScopeState | undefined {
    const direct = this.scopes.get(key);
    if (direct !== undefined) return direct.valid ? direct : undefined;
    const migrated = this.migratedScopes.get(key);
    if (migrated === undefined) return undefined;
    if (!migrated.valid) {
      this.migratedScopes.delete(key);
      return undefined;
    }
    return migrated;
  }

  private scopeHandle(scope: DraftScopeState): PromptAttachmentDraftScope {
    return {
      currentKey: () => scope.valid ? scope.currentKey : undefined,
      read: () => this.readScope(scope),
      write: (draft) => { this.writeScope(scope, draft); },
      clear: () => { this.invalidateScope(scope); },
      beginCapture: () => ({
        complete: (attachments, error) => this.completeCapture(scope, attachments, error),
      }),
    };
  }

  private readScope(scope: DraftScopeState): PromptAttachmentDraft {
    if (!scope.valid || scope.draft === undefined) return { attachments: [] };
    return {
      attachments: [...scope.draft.attachments],
      ...(scope.draft.error === undefined ? {} : { error: scope.draft.error }),
    };
  }

  private writeScope(scope: DraftScopeState, draft: PromptAttachmentDraft): void {
    if (!scope.valid) return;
    // An empty draft holds no user intent, so release its captured bytes. An
    // error-only draft still does, and must survive to stay visible.
    if (draft.attachments.length === 0 && draft.error === undefined) {
      scope.draft = undefined;
      return;
    }
    scope.draft = {
      attachments: [...draft.attachments],
      ...(draft.error === undefined ? {} : { error: draft.error }),
    };
  }

  private completeCapture(
    scope: DraftScopeState,
    attachments: readonly CapturedAttachment[],
    error: string | undefined,
  ): PromptAttachmentDraft | undefined {
    if (!scope.valid) return undefined;
    const existing = scope.draft?.attachments ?? [];
    const merged: PromptAttachmentDraft = {
      attachments: [
        ...existing,
        ...attachments.map((attachment) => ({ id: this.nextAttachmentId(), ...attachment })),
      ],
      ...(error === undefined ? {} : { error }),
    };
    this.writeScope(scope, merged);
    return this.readScope(scope);
  }

  private removeCanonicalMapping(scope: DraftScopeState): void {
    for (const [key, candidate] of this.scopes) {
      if (candidate === scope) this.scopes.delete(key);
    }
  }

  private invalidateScope(scope: DraftScopeState): void {
    scope.valid = false;
    scope.draft = undefined;
    this.removeCanonicalMapping(scope);
    for (const [key, candidate] of this.migratedScopes) {
      if (candidate === scope) this.migratedScopes.delete(key);
    }
  }
}

/** Shared store for the app's lifetime; drafts end when the page unloads. */
export const promptAttachmentDrafts = new PromptAttachmentDraftStore();
