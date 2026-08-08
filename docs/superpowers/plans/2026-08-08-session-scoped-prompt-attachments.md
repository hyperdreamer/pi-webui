# Session-Scoped Prompt Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep unsubmitted prompt attachments with the session they were added to, so switching sessions never shows another session's pending files.

**Architecture:** A new app-lifetime in-memory store maps a `machineId:sessionId` key to an attachment draft snapshot. `PromptEditor` reads and writes the snapshot for its current scope and swaps snapshots when its scope changes. `SessionController` moves and clears snapshots alongside the text drafts it already moves, so a pending start that resolves to a real session ID keeps its attachments.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Lit 3 with decorators, Vitest 4, ESLint with `typescript-eslint` strict type-checked rules.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-08-08-session-scoped-prompt-attachments-design.md`. Read it before Task 1.
- No new runtime dependencies. No new files under `src/server/`. No API route, session-daemon protocol, or durable data-model changes.
- Attachment draft state is in-memory only. Never write attachment bytes to `localStorage`, `sessionStorage`, IndexedDB, cookies, or the network before the user sends.
- Draft keys use `machineSessionKey(machineId, sessionId)` from `src/client/src/machineKeys.ts`, which returns `` `${machineId}:${sessionId}` ``. Never include `cwd` in a key.
- `tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. For an optional property, omit the key entirely with a spread such as `...(error === undefined ? {} : { error })`; never assign `undefined` to an optional property.
- ESLint forbids type assertions entirely (`@typescript-eslint/consistent-type-assertions` with `assertionStyle: "never"`). Use type guards, never `as` and never `!`.
- ESLint enforces `@typescript-eslint/strict-boolean-expressions`. Compare explicitly, for example `if (value !== undefined)` and `if (text !== "")`.
- Vitest runs with no DOM by default. A test file needing a DOM must start with the literal first line `// @vitest-environment jsdom`.
- Run commands from the repository root. Use `npm test -- --run <file>` for one test file.
- Never use `git commit --no-verify`. The pre-commit hook runs typecheck, Knip, and related tests, and must pass.
- Do not modify `docs/superpowers/specs/2026-08-08-session-scoped-prompt-attachments-design.md` or any file under `.agents/`.

## Task 1: Attachment draft store

**Implementer tier:** Standard

**Files:**

- Create: `src/client/src/promptAttachmentDrafts.ts`
- Test: `src/client/src/promptAttachmentDrafts.test.ts`

**Interfaces:**

- Consumes: `CapturedAttachment` from `src/client/src/promptAttachmentCapture.ts`. It is a discriminated union: `{ kind: "image"; name: string; mimeType: string; data: string; size: number }` or the same shape with `kind: "file"`.
- Produces, all exported from `src/client/src/promptAttachmentDrafts.ts`:
  - `type PendingAttachment = CapturedAttachment & { id: string }`
  - `interface PromptAttachmentDraft { attachments: readonly PendingAttachment[]; error?: string }`
  - `class PromptAttachmentDraftStore` with methods `read(key: string): PromptAttachmentDraft`, `write(key: string, draft: PromptAttachmentDraft): void`, `clear(key: string): void`, `move(fromKey: string, toKey: string): void`, `nextAttachmentId(): string`
  - `const promptAttachmentDrafts: PromptAttachmentDraftStore` (the shared app-lifetime instance)

Behavior required of the store:

- `read` on an unknown key returns `{ attachments: [] }` with no `error` key present.
- `read` and `write` copy the attachments array, so a caller mutating an array it passed in or received back cannot change stored state.
- `write` of a draft with no attachments and no error deletes the entry, releasing file bytes.
- `write` of a draft with no attachments but with an error keeps the entry, because a read failure must stay visible on its own session.
- `move` transfers an entry and deletes the source. A `move` from a key with no entry deletes the destination entry, so a stale destination cannot survive.
- `nextAttachmentId` returns `attachment-1`, `attachment-2`, and so on, monotonically for the life of the store instance, never repeating regardless of which keys are written or cleared.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/promptAttachmentDrafts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PromptAttachmentDraftStore, promptAttachmentDrafts, type PendingAttachment } from "./promptAttachmentDrafts";

function imageAttachment(id: string, name: string): PendingAttachment {
  return { id, kind: "image", name, mimeType: "image/png", data: "UE5H", size: 3 };
}

describe("PromptAttachmentDraftStore", () => {
  it("returns an empty draft for an unknown key", () => {
    const store = new PromptAttachmentDraftStore();

    expect(store.read("local:session-a")).toEqual({ attachments: [] });
    expect(Object.hasOwn(store.read("local:session-a"), "error")).toBe(false);
  });

  it("keeps drafts isolated per key", () => {
    const store = new PromptAttachmentDraftStore();
    store.write("local:session-a", { attachments: [imageAttachment("attachment-1", "a.png")] });

    expect(store.read("local:session-b")).toEqual({ attachments: [] });
    expect(store.read("local:session-a").attachments.map((attachment) => attachment.name)).toEqual(["a.png"]);
  });

  it("does not expose stored arrays to callers", () => {
    const store = new PromptAttachmentDraftStore();
    const attachments = [imageAttachment("attachment-1", "a.png")];
    store.write("local:session-a", { attachments });

    attachments.push(imageAttachment("attachment-2", "b.png"));
    const read = store.read("local:session-a");
    const mutableRead: PendingAttachment[] = [...read.attachments];
    mutableRead.push(imageAttachment("attachment-3", "c.png"));

    expect(store.read("local:session-a").attachments.map((attachment) => attachment.name)).toEqual(["a.png"]);
  });

  it("deletes an entry when a draft becomes completely empty", () => {
    const store = new PromptAttachmentDraftStore();
    store.write("local:session-a", { attachments: [imageAttachment("attachment-1", "a.png")] });

    store.write("local:session-a", { attachments: [] });

    expect(store.read("local:session-a")).toEqual({ attachments: [] });
    expect(store.hasEntry("local:session-a")).toBe(false);
  });

  it("retains an error-only draft so a read failure stays visible", () => {
    const store = new PromptAttachmentDraftStore();

    store.write("local:session-a", { attachments: [], error: "Failed to read an attachment." });

    expect(store.read("local:session-a")).toEqual({ attachments: [], error: "Failed to read an attachment." });
    expect(store.hasEntry("local:session-a")).toBe(true);
  });

  it("moves a draft to a new key and clears the source", () => {
    const store = new PromptAttachmentDraftStore();
    store.write("local:pending-session-1", { attachments: [imageAttachment("attachment-1", "a.png")] });

    store.move("local:pending-session-1", "local:real-session");

    expect(store.read("local:pending-session-1")).toEqual({ attachments: [] });
    expect(store.read("local:real-session").attachments.map((attachment) => attachment.name)).toEqual(["a.png"]);
  });

  it("clears the destination when moving from a key with no draft", () => {
    const store = new PromptAttachmentDraftStore();
    store.write("local:real-session", { attachments: [imageAttachment("attachment-1", "stale.png")] });

    store.move("local:pending-session-1", "local:real-session");

    expect(store.read("local:real-session")).toEqual({ attachments: [] });
  });

  it("clears a draft by key", () => {
    const store = new PromptAttachmentDraftStore();
    store.write("local:session-a", { attachments: [imageAttachment("attachment-1", "a.png")], error: "boom" });

    store.clear("local:session-a");

    expect(store.read("local:session-a")).toEqual({ attachments: [] });
  });

  it("allocates attachment ids that never repeat across keys or clears", () => {
    const store = new PromptAttachmentDraftStore();

    const first = store.nextAttachmentId();
    store.write("local:session-a", { attachments: [imageAttachment(first, "a.png")] });
    store.clear("local:session-a");
    const second = store.nextAttachmentId();
    const third = store.nextAttachmentId();

    expect(first).toBe("attachment-1");
    expect(second).toBe("attachment-2");
    expect(third).toBe("attachment-3");
  });

  it("exposes one shared app-lifetime store", () => {
    expect(promptAttachmentDrafts).toBeInstanceOf(PromptAttachmentDraftStore);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/promptAttachmentDrafts.test.ts`
Expected: FAIL, `Cannot find module './promptAttachmentDrafts'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/client/src/promptAttachmentDrafts.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/client/src/promptAttachmentDrafts.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Check types, lint, and unused exports**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx eslint src/client/src/promptAttachmentDrafts.ts src/client/src/promptAttachmentDrafts.test.ts`
Expected: no errors.

Run: `npx knip`
Expected: configuration hints only, and no `Unused exports` section. If Knip reports an unused export from the new module, do not delete the export and do not add a production no-op to silence it; report the finding in the task report instead.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/promptAttachmentDrafts.ts src/client/src/promptAttachmentDrafts.test.ts
git commit -m "feat(client): add session-scoped prompt attachment draft store"
```

## Task 2: Scope attachments in the prompt editor

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/PromptEditor.ts:1-110`
- Modify: `src/client/src/components/PromptEditor.ts:245-345`
- Modify: `src/client/src/components/PromptEditor.ts:530-570`
- Test: `src/client/src/components/PromptEditor.attachmentScope.test.ts`

**Interfaces:**

- Consumes from `../promptAttachmentDrafts` (Task 1): `PromptAttachmentDraftStore` with `read(key: string): PromptAttachmentDraft`, `write(key: string, draft: PromptAttachmentDraft): void`, `clear(key: string): void`, `move(fromKey: string, toKey: string): void`, `nextAttachmentId(): string`, `hasEntry(key: string): boolean`; the shared instance `promptAttachmentDrafts`; the types `PendingAttachment = CapturedAttachment & { id: string }` and `PromptAttachmentDraft { attachments: readonly PendingAttachment[]; error?: string }`.
- Consumes existing `machineSessionKey(machineId: string, sessionId: string): string` from `../machineKeys`.
- Produces: a public `attachmentDrafts` property on `PromptEditor`, typed `PromptAttachmentDraftStore` and defaulting to the shared `promptAttachmentDrafts`, declared as `@property({ attribute: false }) attachmentDrafts: PromptAttachmentDraftStore = promptAttachmentDrafts;` so tests and the app can inject a store.

Current state to change. `PromptEditor` today holds `@state() private attachments: PendingAttachment[] = []`, `@state() private attachmentError: string | undefined = undefined`, and `private attachmentSeq = 0`, with `PendingAttachment` declared locally as `type PendingAttachment = CapturedAttachment & { id: string }`. None of it is scoped to a session, which is the bug. Delete the local `PendingAttachment` declaration and the `attachmentSeq` field, import the type from `../promptAttachmentDrafts`, and keep the two `@state()` fields as the rendered mirror of the active scope.

Required behavior:

- A private helper returns the active scope key, or `undefined` when either `machineId` or `sessionId` is missing or empty. Mirror the existing `draftStorageKey(machineId, sessionId)` guards in the same file: both must be non-empty strings.
- `willUpdate` already handles a `sessionId`/`machineId` change for text drafts. Extend that same branch: save the current rendered attachments to the previous key when that key exists, then load the new key's snapshot into the rendered fields, defaulting to an empty list and no error when the new scope has no key.
- Adding, removing, and clearing attachments writes the active scope's snapshot through to the store, and takes new ids from `attachmentDrafts.nextAttachmentId()`.
- `addAttachmentFiles` captures the scope key **before** awaiting the file read. On completion it writes results to that captured key, and updates the rendered fields only when the captured key still equals the active key. With no key (the starter composer) it keeps today's component-local behavior and must not touch the store.
- `resetComposer` clears the active scope's stored draft along with the rendered fields, so sending leaves nothing behind.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/components/PromptEditor.attachmentScope.test.ts`:

```ts
import type { PropertyValues } from "lit";
import { describe, expect, it, vi } from "vitest";
import { PromptAttachmentDraftStore, type PendingAttachment } from "../promptAttachmentDrafts";
import { PromptEditor } from "./PromptEditor";

type WillUpdate = (this: PromptEditor, changed: PropertyValues<PromptEditor>) => void;
type AddAttachmentFiles = (this: PromptEditor, files: File[]) => Promise<void>;
type SendPrompt = (this: PromptEditor, streamingBehavior?: "steer" | "followUp") => void;

function isWillUpdate(value: unknown): value is WillUpdate {
  return typeof value === "function";
}

function isAddAttachmentFiles(value: unknown): value is AddAttachmentFiles {
  return typeof value === "function";
}

function isSendPrompt(value: unknown): value is SendPrompt {
  return typeof value === "function";
}

/**
 * Drive the component's own scope-change lifecycle. Lit calls `willUpdate` with
 * the previous values when `sessionId` or `machineId` changes, so invoking it
 * directly exercises the real switch path without a DOM or CodeMirror.
 */
function selectSession(editor: PromptEditor, nextSessionId: string): void {
  const previousSessionId = editor.sessionId;
  const method: unknown = Reflect.get(editor, "willUpdate");
  if (!isWillUpdate(method)) throw new Error("PromptEditor.willUpdate is not callable");
  editor.sessionId = nextSessionId;
  const changed: PropertyValues<PromptEditor> = new Map();
  changed.set("sessionId", previousSessionId);
  method.call(editor, changed);
}

function renderedAttachments(editor: PromptEditor): readonly PendingAttachment[] {
  const attachments: unknown = Reflect.get(editor, "attachments");
  if (!Array.isArray(attachments)) throw new Error("PromptEditor attachments are not an array");
  return attachments.map((attachment: unknown) => {
    if (!isPendingAttachment(attachment)) throw new Error("Unexpected pending attachment shape");
    return attachment;
  });
}

function isPendingAttachment(value: unknown): value is PendingAttachment {
  if (typeof value !== "object" || value === null) return false;
  const name: unknown = Reflect.get(value, "name");
  const id: unknown = Reflect.get(value, "id");
  return typeof name === "string" && typeof id === "string";
}

function renderedNames(editor: PromptEditor): string[] {
  return renderedAttachments(editor).map((attachment) => attachment.name);
}

function editorWithStore(store: PromptAttachmentDraftStore, sessionId: string): PromptEditor {
  const editor = new PromptEditor();
  editor.attachmentDrafts = store;
  editor.machineId = "local";
  editor.sessionId = sessionId;
  return editor;
}

function pngFile(name: string): File {
  return new File(["png"], name, { type: "image/png" });
}

/** Minimal FileReader stub whose completion is controlled by the test. */
function installDeferredFileReader(): { finish: (dataUrl: string) => void; fail: () => void; restore: () => void } {
  const hadFileReader = Reflect.has(globalThis, "FileReader");
  const previous: unknown = Reflect.get(globalThis, "FileReader");
  let succeed: ((dataUrl: string) => void) | undefined;
  let reject: (() => void) | undefined;

  class DeferredFileReader {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    error: DOMException | null = null;
    result: string | ArrayBuffer | null = null;

    readAsDataURL(): void {
      succeed = (dataUrl: string) => {
        this.result = dataUrl;
        this.onload?.();
      };
      reject = () => {
        this.error = new DOMException("File unavailable", "NotReadableError");
        this.onerror?.();
      };
    }
  }

  Reflect.set(globalThis, "FileReader", DeferredFileReader);
  return {
    finish: (dataUrl: string) => {
      if (succeed === undefined) throw new Error("readAsDataURL was never called");
      succeed(dataUrl);
    },
    fail: () => {
      if (reject === undefined) throw new Error("readAsDataURL was never called");
      reject();
    },
    restore: () => {
      if (hadFileReader) {
        Reflect.set(globalThis, "FileReader", previous);
        return;
      }
      Reflect.deleteProperty(globalThis, "FileReader");
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let remaining = 0; remaining < 20; remaining += 1) await Promise.resolve();
}

describe("PromptEditor attachment scoping", () => {
  it("hides another session's attachment and restores it on return", () => {
    const store = new PromptAttachmentDraftStore();
    const editor = editorWithStore(store, "session-a");
    store.write("local:session-a", {
      attachments: [{ id: "attachment-1", kind: "image", name: "a.png", mimeType: "image/png", data: "UE5H", size: 3 }],
    });
    selectSession(editor, "session-a");

    expect(renderedNames(editor)).toEqual(["a.png"]);

    selectSession(editor, "session-b");
    expect(renderedNames(editor)).toEqual([]);

    selectSession(editor, "session-a");
    expect(renderedNames(editor)).toEqual(["a.png"]);
  });

  it("keeps a session's own unsent attachment across a round trip without preloading the store", async () => {
    const store = new PromptAttachmentDraftStore();
    const editor = editorWithStore(store, "session-a");
    const reader = installDeferredFileReader();

    try {
      const method: unknown = Reflect.get(editor, "addAttachmentFiles");
      if (!isAddAttachmentFiles(method)) throw new Error("PromptEditor.addAttachmentFiles is not callable");
      const capture = method.call(editor, [pngFile("kept.png")]);
      reader.finish("data:image/png;base64,UE5H");
      await capture;

      expect(renderedNames(editor)).toEqual(["kept.png"]);

      selectSession(editor, "session-b");
      expect(renderedNames(editor)).toEqual([]);

      selectSession(editor, "session-a");
      expect(renderedNames(editor)).toEqual(["kept.png"]);
    } finally {
      reader.restore();
    }
  });

  it("routes a file read that finishes after a session switch to its originating session", async () => {
    const store = new PromptAttachmentDraftStore();
    const editor = editorWithStore(store, "session-a");
    const reader = installDeferredFileReader();

    try {
      const method: unknown = Reflect.get(editor, "addAttachmentFiles");
      if (!isAddAttachmentFiles(method)) throw new Error("PromptEditor.addAttachmentFiles is not callable");
      const capture = method.call(editor, [pngFile("late.png")]);

      selectSession(editor, "session-b");
      reader.finish("data:image/png;base64,UE5H");
      await capture;
      await flushMicrotasks();

      // The late read must not surface in the session the user is now looking at.
      expect(renderedNames(editor)).toEqual([]);
      expect(store.read("local:session-b").attachments).toEqual([]);
      expect(store.read("local:session-a").attachments.map((attachment) => attachment.name)).toEqual(["late.png"]);

      selectSession(editor, "session-a");
      expect(renderedNames(editor)).toEqual(["late.png"]);
    } finally {
      reader.restore();
    }
  });

  it("clears only the sending session's stored draft on send", () => {
    const store = new PromptAttachmentDraftStore();
    const editor = editorWithStore(store, "session-a");
    editor.onSend = vi.fn();
    store.write("local:session-a", {
      attachments: [{ id: "attachment-1", kind: "image", name: "a.png", mimeType: "image/png", data: "UE5H", size: 3 }],
    });
    store.write("local:session-b", {
      attachments: [{ id: "attachment-2", kind: "image", name: "b.png", mimeType: "image/png", data: "UE5H", size: 3 }],
    });
    selectSession(editor, "session-a");

    const method: unknown = Reflect.get(editor, "send");
    if (!isSendPrompt(method)) throw new Error("PromptEditor.send is not callable");
    method.call(editor, undefined);

    expect(editor.onSend).toHaveBeenCalledTimes(1);
    expect(store.read("local:session-a").attachments).toEqual([]);
    expect(store.read("local:session-b").attachments.map((attachment) => attachment.name)).toEqual(["b.png"]);
    expect(renderedNames(editor)).toEqual([]);
  });

  it("keeps a read failure on the session that attempted it", async () => {
    const store = new PromptAttachmentDraftStore();
    const editor = editorWithStore(store, "session-a");
    const reader = installDeferredFileReader();

    try {
      const method: unknown = Reflect.get(editor, "addAttachmentFiles");
      if (!isAddAttachmentFiles(method)) throw new Error("PromptEditor.addAttachmentFiles is not callable");
      const capture = method.call(editor, [pngFile("broken.png")]);
      reader.fail();
      await capture;

      expect(Reflect.get(editor, "attachmentError")).toBe("Failed to read an attachment.");

      selectSession(editor, "session-b");
      expect(Reflect.get(editor, "attachmentError")).toBeUndefined();
      expect(store.read("local:session-b").error).toBeUndefined();

      selectSession(editor, "session-a");
      expect(Reflect.get(editor, "attachmentError")).toBe("Failed to read an attachment.");
    } finally {
      reader.restore();
    }
  });

  it("keeps starter attachments component-local when no session scope exists", async () => {
    const store = new PromptAttachmentDraftStore();
    const editor = new PromptEditor();
    editor.attachmentDrafts = store;
    editor.machineId = "local";
    const reader = installDeferredFileReader();

    try {
      const method: unknown = Reflect.get(editor, "addAttachmentFiles");
      if (!isAddAttachmentFiles(method)) throw new Error("PromptEditor.addAttachmentFiles is not callable");
      const capture = method.call(editor, [pngFile("starter.png")]);
      reader.finish("data:image/png;base64,UE5H");
      await capture;

      expect(renderedNames(editor)).toEqual(["starter.png"]);
      expect(store.hasEntry("local:")).toBe(false);
      expect(store.hasEntry("local:undefined")).toBe(false);
    } finally {
      reader.restore();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/PromptEditor.attachmentScope.test.ts`
Expected: FAIL. The first failure is a TypeScript/runtime error that `attachmentDrafts` does not exist on `PromptEditor`, since the property is introduced in Step 3.

- [ ] **Step 3: Write the minimal implementation**

In `src/client/src/components/PromptEditor.ts`, delete the local `type PendingAttachment = CapturedAttachment & { id: string };` declaration and import from the new module instead. Adjust the existing import of `../promptAttachmentCapture` to drop `type CapturedAttachment` if it becomes unused there:

```ts
import { promptAttachmentDrafts, PromptAttachmentDraftStore, type PendingAttachment, type PromptAttachmentDraft } from "../promptAttachmentDrafts";
```

Add the injectable store beside the other `@property` declarations and delete the `private attachmentSeq = 0;` field:

```ts
  /** Injectable so tests and the app share one app-lifetime draft store. */
  @property({ attribute: false }) attachmentDrafts: PromptAttachmentDraftStore = promptAttachmentDrafts;
```

Replace the body of `willUpdate` with this version, which adds the attachment swap to the existing text-draft handling:

```ts
  protected override willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("sessionId") && !changed.has("machineId")) return;
    const previousSessionId = changed.has("sessionId") ? changed.get("sessionId") : this.sessionId;
    const previousMachineId = changed.has("machineId") ? changed.get("machineId") : this.machineId;
    const previousKey = draftStorageKey(previousMachineId, previousSessionId);
    if (previousKey !== undefined) saveDraft(previousKey, this.draft);
    // Park the outgoing session's unsent attachments before adopting the next
    // session's, so switching away never carries files into another session.
    if (previousKey !== undefined) this.attachmentDrafts.write(previousKey, this.currentAttachmentDraft());
    const currentKey = draftStorageKey(this.machineId, this.sessionId);
    this.draft = currentKey !== undefined ? loadDraft(currentKey) : "";
    this.adoptAttachmentDraft(currentKey === undefined ? { attachments: [] } : this.attachmentDrafts.read(currentKey));
    this.currentInputMode = inputModeForDraft(this.draft);
    this.completions = [];
    this.selectedIndex = 0;
  }
```

Add these private helpers next to the other attachment methods:

```ts
  /** The active draft key, or `undefined` for the starter composer. */
  private attachmentScopeKey(): string | undefined {
    return draftStorageKey(this.machineId, this.sessionId);
  }

  private currentAttachmentDraft(): PromptAttachmentDraft {
    return {
      attachments: this.attachments,
      ...(this.attachmentError === undefined ? {} : { error: this.attachmentError }),
    };
  }

  private adoptAttachmentDraft(draft: PromptAttachmentDraft): void {
    this.attachments = [...draft.attachments];
    this.attachmentError = draft.error;
  }

  /** Mirror the rendered attachment state into the active scope's stored draft. */
  private persistAttachmentDraft(): void {
    const key = this.attachmentScopeKey();
    if (key === undefined) return;
    this.attachmentDrafts.write(key, this.currentAttachmentDraft());
  }
```

Change `removeAttachment` to persist after filtering:

```ts
  private removeAttachment(id: string) {
    this.attachments = this.attachments.filter((attachment) => attachment.id !== id);
    this.persistAttachmentDraft();
  }
```

Replace `addAttachmentFiles` so a late read lands on its originating session:

```ts
  private async addAttachmentFiles(files: File[]) {
    // Capture the scope before awaiting: the user may select another session
    // while the read is outstanding, and these bytes belong to the session that
    // was active when they were dropped, pasted, or picked.
    const scopeKey = this.attachmentScopeKey();
    if (scopeKey === undefined) {
      this.attachmentError = undefined;
      const starter = await capturePromptAttachments(files, readFileAsBase64);
      if (starter.attachments.length > 0) {
        this.attachments = [...this.attachments, ...starter.attachments.map((attachment) => ({ id: this.attachmentDrafts.nextAttachmentId(), ...attachment }))];
      }
      this.attachmentError = starter.error;
      return;
    }

    if (scopeKey === this.attachmentScopeKey()) this.attachmentError = undefined;
    const { attachments, error } = await capturePromptAttachments(files, readFileAsBase64);
    // Re-read rather than reusing a pre-await copy, so a second capture that
    // finished first is not dropped. The error comes only from this batch, so a
    // prior failure cannot survive a later successful read.
    const existing = this.attachmentDrafts.read(scopeKey);
    const merged: PromptAttachmentDraft = {
      attachments: [...existing.attachments, ...attachments.map((attachment) => ({ id: this.attachmentDrafts.nextAttachmentId(), ...attachment }))],
      ...(error === undefined ? {} : { error }),
    };
    this.attachmentDrafts.write(scopeKey, merged);
    if (scopeKey !== this.attachmentScopeKey()) return;
    this.adoptAttachmentDraft(merged);
  }
```

Change `resetComposer` to clear the stored draft too:

```ts
  private resetComposer() {
    this.draft = "";
    this.currentInputMode = { kind: "normal" };
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) clearDraft(key);
    this.completions = [];
    this.attachments = [];
    this.attachmentError = undefined;
    if (key !== undefined) this.attachmentDrafts.clear(key);
    // `draft` is not reactive, so the cleared text will not flow to CodeMirror
    // via `updated()`; push it to the editor document explicitly.
    this.syncEditorDoc();
  }
```

`this.attachmentError = draft.error;` and `this.attachmentError = starter.error;` are assignments to a `string | undefined` field, which is allowed. Do not convert the `attachmentError` field to an optional property, or `exactOptionalPropertyTypes` will reject those assignments.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/PromptEditor.attachmentScope.test.ts`
Expected: PASS, 6 tests.

Run the existing prompt-editor and attachment suites to confirm no regression:

```bash
npm test -- --run src/client/src/promptAttachmentCapture.test.ts
npm test -- --run src/client/src/components/PromptEditor.draft.test.ts
npm test -- --run src/client/src/components/PromptEditor.sessionConfiguration.test.ts
```

Expected: all PASS. `promptAttachmentCapture.test.ts` reaches into `attachments` with `Reflect.set` and asserts ids `attachment-1` and `attachment-2`; those ids now come from the shared store's counter, so if that file fails on an id mismatch, fix it by having the test set ids it controls rather than by reintroducing a per-component counter. Report any such edit in the task report.

- [ ] **Step 5: Check types and lint**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx eslint src/client/src/components/PromptEditor.ts src/client/src/components/PromptEditor.attachmentScope.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/components/PromptEditor.ts src/client/src/components/PromptEditor.attachmentScope.test.ts src/client/src/promptAttachmentCapture.test.ts
git commit -m "fix(client): scope pending prompt attachments to their session"
```

## Task 3: Carry attachment drafts through session lifecycle changes

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/controllers/sessionController.ts:1-30`
- Modify: `src/client/src/controllers/sessionController.ts:74-90`
- Modify: `src/client/src/controllers/sessionController.ts:138-240`
- Modify: `src/client/src/controllers/sessionController.ts:1038-1060`
- Modify: `src/client/src/controllers/sessionController.ts:1620-1660`
- Modify: `src/client/src/controllers/sessionController.ts:1735-1750`
- Test: `src/client/src/controllers/sessionController.attachmentDrafts.test.ts`

**Interfaces:**

- Consumes from `../promptAttachmentDrafts` (Task 1): the shared `promptAttachmentDrafts` instance and the `PromptAttachmentDraftStore` type, whose relevant methods are `move(fromKey: string, toKey: string): void`, `clear(key: string): void`, `read(key: string): PromptAttachmentDraft`, `write(key: string, draft: PromptAttachmentDraft): void`, and `hasEntry(key: string): boolean`.
- Consumes existing `machineSessionKey(machineId: string, sessionId: string): string` from `../machineKeys`, and the existing private `sessionCacheKey(sessionId: string): string` on `SessionController`, which returns `machineSessionKey(selectedMachineId(this.getState()), sessionId)`.
- Produces: a new optional dependency on the existing `SessionControllerDependencies` interface, `attachmentDrafts?: PromptAttachmentDraftStore`, stored as a private readonly field defaulting to `promptAttachmentDrafts`, so every current construction site and test keeps working unchanged.

Why this task exists: while a start is pending, the composer is scoped to a temporary id such as `pending-session-3-lz4k9`. When the start resolves, `sessionId` becomes the real id, so an attachment draft left under the temporary key would silently vanish from a composer the user never cleared. The controller already calls `moveDraft` and `clearDraft` at exactly these points; attachment drafts must follow.

The three call sites to change, each already handling the text draft:

1. `resolvePendingSessionStart`: on the discarded path it calls `clearDraft(machineSessionKey(pending.machineId, tempId))`; add a matching `clear`. On the success path it calls `moveDraft(machineSessionKey(pending.machineId, tempId), machineSessionKey(pending.machineId, session.id))`; add a matching `move`.
2. `recreateCachedNewSession`: it calls `moveDraft(this.sessionCacheKey(session.id), this.sessionCacheKey(replacement.id))`; add a matching `move`.
3. `deleteCachedNewSession`: it calls `clearDraft(this.sessionCacheKey(session.id))`; add a matching `clear`.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/controllers/sessionController.attachmentDrafts.test.ts`. Import the shared harness from `./sessionController.testSupport`, which already exports `defaultApi`, `FakeSocket`, `MemoryStorage`, `deferred`, `emptyPage`, `oldSession`, `sessionKey`, `sessionLookupId`, `status`, `workspace`, and the `AppState`/`SessionInfo` types. That module also installs a controllable `requestAnimationFrame` and clears `localStorage` in its own hooks, so do not redefine any of it:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { PromptAttachmentDraftStore, type PendingAttachment } from "../promptAttachmentDrafts";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, MemoryStorage, oldSession, sessionKey, sessionLookupId, status, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

function attachment(id: string, name: string): PendingAttachment {
  return { id, kind: "image", name, mimeType: "image/png", data: "UE5H", size: 3 };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

describe("SessionController attachment draft lifecycle", () => {
  it("moves an attachment draft from a temporary id to the resolved session id", async () => {
    const attachmentDrafts = new PromptAttachmentDraftStore();
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), attachmentDrafts },
    );

    const start = controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected a temporary session id");
    attachmentDrafts.write(sessionKey(temporaryId), { attachments: [attachment("attachment-1", "queued.png")] });

    startRequest.resolve(started);
    await start;

    expect(attachmentDrafts.read(sessionKey(temporaryId)).attachments).toEqual([]);
    expect(attachmentDrafts.read(sessionKey("started-session")).attachments.map((item) => item.name)).toEqual(["queued.png"]);
  });

  it("clears the attachment draft of a discarded transient session", async () => {
    const attachmentDrafts = new PromptAttachmentDraftStore();
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => startRequest.promise,
      stop: () => Promise.resolve({ stopped: true }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), attachmentDrafts },
    );

    void controller.startSession();
    const temporaryId = state.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected a temporary session id");
    attachmentDrafts.write(sessionKey(temporaryId), { attachments: [attachment("attachment-1", "abandoned.png")] });

    await controller.deleteCachedNewSession(state.selectedSession);

    expect(attachmentDrafts.hasEntry(sessionKey(temporaryId))).toBe(false);
  });
});
```

If an assertion fails because the controller defers a state update behind an animation frame, import `runPendingAnimationFrames` from the same harness and drive a frame before asserting rather than adding a sleep.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/controllers/sessionController.attachmentDrafts.test.ts`
Expected: FAIL, because `attachmentDrafts` is not an accepted dependency and no draft is moved or cleared.

- [ ] **Step 3: Write the minimal implementation**

In `src/client/src/controllers/sessionController.ts`, add the import:

```ts
import { promptAttachmentDrafts, type PromptAttachmentDraftStore } from "../promptAttachmentDrafts";
```

Add the dependency to `SessionControllerDependencies`, beside `replacePromptEditorText`:

```ts
  /** Session-scoped composer attachment drafts, moved and cleared with text drafts. */
  attachmentDrafts?: PromptAttachmentDraftStore;
```

Add the field beside the other private readonly dependencies and assign it in the constructor next to `this.api = deps.api ?? defaultApi;`:

```ts
  private readonly attachmentDrafts: PromptAttachmentDraftStore;
```

```ts
    this.attachmentDrafts = deps.attachmentDrafts ?? promptAttachmentDrafts;
```

In `resolvePendingSessionStart`, on the discarded branch, directly after `clearDraft(machineSessionKey(pending.machineId, tempId));`:

```ts
      this.attachmentDrafts.clear(machineSessionKey(pending.machineId, tempId));
```

In the same method, directly after the success-path `moveDraft(...)` call:

```ts
    // The composer was scoped to the temporary id; without this move an unsent
    // attachment would disappear when `sessionId` becomes the real id.
    this.attachmentDrafts.move(machineSessionKey(pending.machineId, tempId), machineSessionKey(pending.machineId, session.id));
```

In `recreateCachedNewSession`, directly after its `moveDraft(...)` call:

```ts
      this.attachmentDrafts.move(this.sessionCacheKey(session.id), this.sessionCacheKey(replacement.id));
```

In `deleteCachedNewSession`, directly after `clearDraft(this.sessionCacheKey(session.id));`:

```ts
    this.attachmentDrafts.clear(this.sessionCacheKey(session.id));
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/controllers/sessionController.attachmentDrafts.test.ts`
Expected: PASS, 2 tests.

Run the neighbouring session-controller suites:

```bash
npm test -- --run src/client/src/controllers/sessionController.pendingStarts.test.ts
npm test -- --run src/client/src/controllers/sessionController.cachedNew.test.ts
```

Expected: both PASS.

- [ ] **Step 5: Check types and lint**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx eslint src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.attachmentDrafts.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.attachmentDrafts.test.ts
git commit -m "fix(client): carry attachment drafts across session id changes"
```

## Task 4: Release notes and full verification

**Implementer tier:** Standard

**Files:**

- Create: `.changeset/session-scoped-prompt-attachments.md`

**Interfaces:**

- Consumes: the completed behavior from Tasks 1 through 3. No code interface.
- Produces: a patch Changeset fragment for `@hyperdreamer/pi-webui`, plus a recorded full-suite verification result.

- [ ] **Step 1: Write the Changeset**

Create `.changeset/session-scoped-prompt-attachments.md` with exactly this content:

```md
---
"@hyperdreamer/pi-webui": patch
---

Keep unsubmitted prompt attachments with the session they were added to, so switching sessions no longer shows another session's pending files.
```

Do not edit `CHANGELOG.md`; it is generated at release time.

- [ ] **Step 2: Run the full verification suite**

Run: `npm run verify:fast`
Expected: PASS. Do not run this concurrently with any other heavy job; this repository's suite is timing-sensitive and concurrent load causes unrelated 5000ms timeouts.

If a test times out, re-run that one file alone with `npm run test:serial -- --run <file>` before concluding anything is broken, and record both results in the task report.

- [ ] **Step 3: Confirm the packaged build is unaffected**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .changeset/session-scoped-prompt-attachments.md
git commit -m "docs(changeset): note session-scoped prompt attachments fix"
```
