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

  it("finishes a pending capture in a moved scope without recreating the source", async () => {
    const store = new PromptAttachmentDraftStore();
    const editor = editorWithStore(store, "temporary-session");
    store.write("local:temporary-session", {
      attachments: [{ id: "attachment-1", kind: "image", name: "existing.png", mimeType: "image/png", data: "UE5H", size: 3 }],
    });
    selectSession(editor, "temporary-session");
    const reader = installDeferredFileReader();

    try {
      const method: unknown = Reflect.get(editor, "addAttachmentFiles");
      if (!isAddAttachmentFiles(method)) throw new Error("PromptEditor.addAttachmentFiles is not callable");
      const capture = method.call(editor, [pngFile("migrating.png")]);

      store.move("local:temporary-session", "local:real-session");
      selectSession(editor, "real-session");
      reader.finish("data:image/png;base64,UE5H");
      await capture;
      await flushMicrotasks();

      expect(store.read("local:real-session").attachments.map((attachment) => attachment.name)).toEqual(["existing.png", "migrating.png"]);
      expect(store.read("local:temporary-session").attachments).toEqual([]);
      expect(renderedNames(editor)).toEqual(["existing.png", "migrating.png"]);
    } finally {
      reader.restore();
    }
  });

  it("preserves a moved capture that finishes before the editor scope update", async () => {
    const store = new PromptAttachmentDraftStore();
    const editor = editorWithStore(store, "temporary-session");
    store.write("local:temporary-session", {
      attachments: [{ id: "attachment-1", kind: "image", name: "existing.png", mimeType: "image/png", data: "UE5H", size: 3 }],
    });
    selectSession(editor, "temporary-session");
    const reader = installDeferredFileReader();

    try {
      const method: unknown = Reflect.get(editor, "addAttachmentFiles");
      if (!isAddAttachmentFiles(method)) throw new Error("PromptEditor.addAttachmentFiles is not callable");
      const capture = method.call(editor, [pngFile("migrating.png")]);

      store.move("local:temporary-session", "local:real-session");
      reader.finish("data:image/png;base64,UE5H");
      await capture;
      await flushMicrotasks();
      expect(store.read("local:real-session").attachments.map((attachment) => attachment.name)).toEqual(["existing.png", "migrating.png"]);

      selectSession(editor, "real-session");

      expect(store.read("local:real-session").attachments.map((attachment) => attachment.name)).toEqual(["existing.png", "migrating.png"]);
      expect(store.read("local:temporary-session").attachments).toEqual([]);
      expect(renderedNames(editor)).toEqual(["existing.png", "migrating.png"]);
    } finally {
      reader.restore();
    }
  });

  it("does not recreate a cleared scope when a pending capture and scope update settle", async () => {
    const store = new PromptAttachmentDraftStore();
    const editor = editorWithStore(store, "temporary-session");
    store.write("local:temporary-session", {
      attachments: [{ id: "attachment-1", kind: "image", name: "existing.png", mimeType: "image/png", data: "UE5H", size: 3 }],
    });
    selectSession(editor, "temporary-session");
    const reader = installDeferredFileReader();

    try {
      const method: unknown = Reflect.get(editor, "addAttachmentFiles");
      if (!isAddAttachmentFiles(method)) throw new Error("PromptEditor.addAttachmentFiles is not callable");
      const capture = method.call(editor, [pngFile("discarded.png")]);

      store.clear("local:temporary-session");
      selectSession(editor, "other-session");
      expect(store.hasEntry("local:temporary-session")).toBe(false);

      reader.finish("data:image/png;base64,UE5H");
      await capture;
      await flushMicrotasks();

      expect(store.read("local:temporary-session").attachments).toEqual([]);
      expect(store.hasEntry("local:temporary-session")).toBe(false);
      expect(renderedNames(editor)).toEqual([]);
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
