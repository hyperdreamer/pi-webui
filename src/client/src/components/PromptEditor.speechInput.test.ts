// @vitest-environment jsdom

import { EditorSelection, EditorState } from "@codemirror/state";
import { render } from "lit";
import type { PropertyValues } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechInputSettingsResponse } from "../../../shared/apiTypes";
import type { SpeechInputControllerState } from "../controllers/speechInputController";
import type { SpeechInputTargetSnapshot } from "../speechInput/speechInputCore";
import type { BrowserRecognitionEvent, BrowserRecognitionResult, BrowserRecognitionResultsList, BrowserSpeechRecognition } from "../speechInput/speechRecognitionAdapter";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import type { PendingAttachment } from "../promptAttachmentDrafts";
import { PromptEditor } from "./PromptEditor";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

type ConfigureSpeechController = (settings: SpeechInputSettingsResponse | undefined) => void;
type StartSpeechController = (target: SpeechInputTargetSnapshot) => void;
type StopSpeechController = () => void;
type CancelSpeechController = () => boolean;
type DisposeSpeechController = () => void;

interface SpeechControllerReplacement {
  configure: ReturnType<typeof vi.fn<ConfigureSpeechController>>;
  start: ReturnType<typeof vi.fn<StartSpeechController>>;
  stop: ReturnType<typeof vi.fn<StopSpeechController>>;
  cancel: ReturnType<typeof vi.fn<CancelSpeechController>>;
  dispose: ReturnType<typeof vi.fn<DisposeSpeechController>>;
}

let documentExecCommandDescriptor: PropertyDescriptor | undefined;

const BROWSER_SPEECH_SETTINGS: SpeechInputSettingsResponse = {
  contractVersion: 1,
  revision: "00000000-0000-4000-8000-000000000001",
  settings: {
    provider: "browser",
    cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" },
  },
  credential: { configured: false, resolution: "missing" },
};

/** Controlled external browser API; PromptEditor still creates its production controller and adapter. */
class ControlledBrowserRecognition implements BrowserSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((event: BrowserRecognitionEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  startCalls = 0;
  stop = vi.fn();
  abort = vi.fn();

  start(): void {
    this.startCalls += 1;
  }

  emitStart(): void {
    this.onstart?.();
  }

  emitResult(segments: readonly { transcript: string; isFinal: boolean }[]): void {
    this.onresult?.({ results: controlledRecognitionResults(segments) });
  }

  emitEnd(): void {
    this.onend?.();
  }
}

function controlledRecognitionResults(
  segments: readonly { transcript: string; isFinal: boolean }[],
): BrowserRecognitionResultsList {
  const results: Record<number, BrowserRecognitionResult> = {};
  for (const [index, segment] of segments.entries()) {
    results[index] = { isFinal: segment.isFinal, length: 1, 0: { transcript: segment.transcript } };
  }
  return { length: segments.length, ...results };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  vi.stubGlobal("matchMedia", mediaQuery);
  // CodeMirror's focus path checks this legacy DOM API in jsdom's Safari branch.
  documentExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
  if (documentExecCommandDescriptor === undefined) {
    Reflect.deleteProperty(document, "execCommand");
  } else {
    Object.defineProperty(document, "execCommand", documentExecCommandDescriptor);
  }
  documentExecCommandDescriptor = undefined;
});

describe("PromptEditor speech input target boundary", () => {
  it("captures discriminated starter and session identities from nonempty composer fields", async () => {
    const editor = await mountedEditor();
    editor.view?.dispatch({ selection: EditorSelection.range(0, 0) });

    expect(captureTarget(editor)).toEqual({
      identity: { kind: "starter", machineId: "machine-a", projectId: "project-a", workspaceId: "workspace-a" },
      text: "",
      from: 0,
      to: 0,
    });

    editor.sessionId = "session-a";
    editor.view?.dispatch({ selection: EditorSelection.range(0, 0) });

    expect(captureTarget(editor)).toEqual({
      identity: {
        kind: "session",
        machineId: "machine-a",
        projectId: "project-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
      },
      text: "",
      from: 0,
      to: 0,
    });
  });

  it("replaces selected text in one transaction, persists through the normal update listener, and places the caret after dictation", async () => {
    const editor = await mountedEditor({ sessionId: "session-a" });
    editor.replaceText("hello world");
    const view = requiredView(editor);
    view.dispatch({ selection: EditorSelection.range(6, 11) });
    const target = requiredTarget(editor);
    const dispatch = vi.spyOn(view, "dispatch");

    expect(loadDraft(machineSessionKey("machine-a", "session-a"))).toBe("hello world");
    expect(applyFinal(editor, target, "there")).toBe("inserted");

    expect(dispatch).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("hello there");
    expect(view.state.selection.main.from).toBe(11);
    expect(view.state.selection.main.to).toBe(11);
    expect(loadDraft(machineSessionKey("machine-a", "session-a"))).toBe("hello there");
  });

  it("uses the transcript insertion spacing at a caret and keeps draft storage unchanged for interim text", async () => {
    const editor = await mountedEditor({ sessionId: "session-a" });
    editor.replaceText("hello world");
    const view = requiredView(editor);
    view.dispatch({ selection: EditorSelection.cursor(5) });
    const target = requiredTarget(editor);

    applyInterim(editor, target, " there");

    expect(view.state.doc.toString()).toBe("hello world");
    expect(loadDraft(machineSessionKey("machine-a", "session-a"))).toBe("hello world");
    expect(view.dom.querySelector(".prompt-speech-interim")?.textContent).toBe(" there");

    expect(applyFinal(editor, target, "there")).toBe("inserted");
    expect(view.state.doc.toString()).toBe("hello there world");
    expect(view.state.selection.main.head).toBe(11);
  });

  it("rejects a late final after a programmatic draft replacement", async () => {
    const editor = await mountedEditor({ sessionId: "session-a" });
    editor.replaceText("captured draft");
    const target = requiredTarget(editor);
    editor.replaceText("newer draft");

    expect(applyFinal(editor, target, "dictated words")).toBe("changed");
    expect(requiredView(editor).state.doc.toString()).toBe("newer draft");
    expect(loadDraft(machineSessionKey("machine-a", "session-a"))).toBe("newer draft");
  });

  it("uses field equality rather than a serialized identity when rejecting late finals", async () => {
    const editor = await mountedEditor();
    editor.machineId = "machine:project";
    editor.projectId = "workspace";
    editor.workspaceId = "root";
    const target = requiredTarget(editor);

    // Both tuples would stringify to "machine:project:workspace:root" with a
    // naive colon join, but they name different composer scopes.
    editor.machineId = "machine";
    editor.projectId = "project:workspace";

    expect(applyFinal(editor, target, "dictated words")).toBe("changed");
    expect(requiredView(editor).state.doc.toString()).toBe("");
  });

  it("cancels before adopting a changed session, machine, project, or workspace", () => {
    const editor = new PromptEditor();
    editor.machineId = "machine-a";
    editor.projectId = "project-a";
    editor.workspaceId = "workspace-a";
    editor.sessionId = "session-a";
    Reflect.set(editor, "draft", "outgoing draft");
    saveDraft(machineSessionKey("machine-b", "session-b"), "incoming draft");
    const controller = installController(editor);
    const draftWhenCanceled: string[] = [];
    controller.cancel.mockImplementation(() => {
      draftWhenCanceled.push(String(Reflect.get(editor, "draft")));
      return true;
    });

    updateProperty(editor, "sessionId", "session-b");
    updateProperty(editor, "machineId", "machine-b");
    updateProperty(editor, "projectId", "project-b");
    updateProperty(editor, "workspaceId", "workspace-b");

    expect(controller.cancel).toHaveBeenCalledTimes(4);
    expect(draftWhenCanceled[0]).toBe("outgoing draft");
    expect(Reflect.get(editor, "draft")).toBe("incoming draft");
  });

  it("cancels, disposes, clears interim state, and destroys CodeMirror on disconnect", async () => {
    const editor = await mountedEditor({ sessionId: "session-a" });
    const controller = installController(editor);
    const view = requiredView(editor);
    const dispatch = vi.spyOn(view, "dispatch");
    const destroy = vi.spyOn(view, "destroy");

    editor.remove();

    expect(controller.cancel).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("PromptEditor default speech controller bridge", () => {
  it("renders, clears, refocuses, and commits Browser dictation through the mounted controller lifecycle", async () => {
    const recognitions = installControlledBrowserRecognition();
    const editor = await mountedEditor({
      sessionId: "session-a",
      speechInputSettings: BROWSER_SPEECH_SETTINGS,
    });
    await editor.updateComplete;
    const view = requiredView(editor);
    editor.replaceText("draft");
    view.dispatch({ selection: EditorSelection.cursor(5) });

    expect(mountedSpeechInputButton(editor).title).toBe("Start dictation · Browser");
    mountedSpeechInputButton(editor).click();
    const firstRecognition = requiredRecognition(recognitions, 0);
    expect(firstRecognition.startCalls).toBe(1);
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    await editor.updateComplete;
    expect(mountedEditorHost(editor).getAttribute("aria-readonly")).toBe("true");
    expect(mountedSpeechInputButton(editor).title).toBe("Cancel dictation · Browser");

    firstRecognition.emitStart();
    await editor.updateComplete;
    expect(mountedSpeechInputButton(editor).title).toBe("Stop dictation · Browser");

    firstRecognition.emitResult([{ transcript: "spoken", isFinal: false }]);
    expect(view.state.doc.toString()).toBe("draft");
    expect(loadDraft(machineSessionKey("machine-a", "session-a"))).toBe("draft");
    expect(view.dom.querySelector(".prompt-speech-interim")?.textContent).toBe("spoken");

    mountedSpeechInputButton(editor).focus();
    expect(view.hasFocus).toBe(false);
    expect(editor.cancelSpeechInput()).toBe(true);
    expect(firstRecognition.abort).toHaveBeenCalledOnce();
    await editor.updateComplete;
    await Promise.resolve();
    expect(view.state.facet(EditorState.readOnly)).toBe(false);
    expect(view.dom.querySelector(".prompt-speech-interim")).toBeNull();
    expect(view.hasFocus).toBe(true);

    mountedSpeechInputButton(editor).click();
    const secondRecognition = requiredRecognition(recognitions, 1);
    secondRecognition.emitStart();
    secondRecognition.emitResult([{ transcript: "spoken words", isFinal: true }]);
    secondRecognition.emitEnd();
    await editor.updateComplete;
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe("draft spoken words");
    expect(loadDraft(machineSessionKey("machine-a", "session-a"))).toBe("draft spoken words");
    expect(view.dom.querySelector(".prompt-speech-interim")).toBeNull();
    expect(view.state.facet(EditorState.readOnly)).toBe(false);
    expect(mountedEditorHost(editor).hasAttribute("aria-readonly")).toBe(false);
    expect(mountedSpeechInputButton(editor).title).toBe("Start dictation · Browser");
  });
});

describe("PromptEditor speech input controls", () => {
  it("renders the microphone immediately before Send with provider, phase, elapsed, error, and unavailable feedback", () => {
    const editor = new PromptEditor();

    setSpeechState(editor, { kind: "idle", provider: "browser" });
    let host = renderPromptEditor(editor);
    let microphone = requiredButton(host, ".speech-input-button");
    expect(microphone.nextElementSibling?.classList.contains("send-button")).toBe(true);
    expect(microphone.title).toBe("Start dictation · Browser");
    expect(microphone.getAttribute("aria-label")).toBe("Start dictation · Browser");

    setSpeechState(editor, { kind: "requesting-permission", runId: "run-1", provider: "browser" });
    host = renderPromptEditor(editor);
    microphone = requiredButton(host, ".speech-input-button");
    expect(microphone.title).toBe("Cancel dictation · Browser");
    expect(host.textContent).toContain("Requesting microphone permission · Browser");

    setSpeechState(editor, { kind: "listening", runId: "run-1", provider: "cloud", elapsedMs: 62_000 });
    host = renderPromptEditor(editor);
    microphone = requiredButton(host, ".speech-input-button");
    expect(microphone.title).toBe("Stop dictation · Cloud");
    expect(host.textContent).toContain("Listening · Cloud · 01:02");

    setSpeechState(editor, { kind: "transcribing", runId: "run-1", provider: "cloud", elapsedMs: 62_000 });
    host = renderPromptEditor(editor);
    microphone = requiredButton(host, ".speech-input-button");
    expect(microphone.title).toBe("Cancel transcription · Cloud");
    expect(host.textContent).toContain("Transcribing · Cloud");

    setSpeechState(editor, { kind: "idle", unavailableReason: "Microphone permission is unavailable", error: "Speech recognition failed" });
    host = renderPromptEditor(editor);
    microphone = requiredButton(host, ".speech-input-button");
    expect(microphone.disabled).toBe(true);
    expect(microphone.title).toBe("Microphone permission is unavailable");
    const error = host.querySelector(".speech-input-error");
    expect(error?.getAttribute("aria-live")).toBe("polite");
    expect(error?.textContent).toBe("Speech recognition failed");
  });

  it("uses phase-specific microphone actions without starting a provider when the target is unavailable", async () => {
    const editor = await mountedEditor({ sessionId: "session-a" });
    const controller = installController(editor);

    setSpeechState(editor, { kind: "idle", provider: "browser" });
    invokeVoid(editor, "handleSpeechInputControl");
    expect(controller.start).toHaveBeenCalledOnce();

    setSpeechState(editor, { kind: "requesting-permission", runId: "run-1", provider: "browser" });
    invokeVoid(editor, "handleSpeechInputControl");
    setSpeechState(editor, { kind: "listening", runId: "run-1", provider: "browser", elapsedMs: 0 });
    invokeVoid(editor, "handleSpeechInputControl");
    setSpeechState(editor, { kind: "transcribing", runId: "run-1", provider: "cloud", elapsedMs: 0 });
    invokeVoid(editor, "handleSpeechInputControl");

    expect(controller.cancel).toHaveBeenCalledTimes(2);
    expect(controller.stop).toHaveBeenCalledOnce();

    const missingEditor = new PromptEditor();
    missingEditor.machineId = "machine-a";
    missingEditor.projectId = "project-a";
    missingEditor.workspaceId = "workspace-a";
    const unavailableController = installController(missingEditor);
    setSpeechState(missingEditor, { kind: "idle", provider: "browser" });

    invokeVoid(missingEditor, "handleSpeechInputControl");

    expect(unavailableController.start).not.toHaveBeenCalled();
    expect(speechState(missingEditor)).toMatchObject({
      kind: "idle",
      error: "Speech input is unavailable for this composer.",
    });
  });

  it("disables an externally disabled idle microphone and rejects programmatic starts before touching the editor", async () => {
    const editor = await mountedEditor({ sessionId: "session-a" });
    const controller = installController(editor);
    const view = requiredView(editor);
    setSpeechState(editor, { kind: "idle", provider: "browser" });
    editor.disabled = true;
    await editor.updateComplete;
    const dispatch = vi.spyOn(view, "dispatch");

    const microphone = requiredButton(renderPromptEditor(editor), ".speech-input-button");
    expect(microphone.disabled).toBe(true);
    expect(microphone.title).toBe("Dictation is unavailable while this prompt is disabled.");

    invokeVoid(editor, "handleSpeechInputControl");
    invokeVoid(editor, "startSpeechInput");

    expect(controller.start).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(speechState(editor)).toEqual({ kind: "idle", provider: "browser" });
  });

  it("cancels an active run and rejects a late final after the editor becomes externally disabled", async () => {
    const editor = await mountedEditor({ sessionId: "session-a" });
    const controller = installController(editor);
    editor.replaceText("captured draft");
    const target = requiredTarget(editor);
    setSpeechState(editor, { kind: "listening", runId: "run-1", provider: "browser", elapsedMs: 0 });

    editor.disabled = true;
    await editor.updateComplete;
    const view = requiredView(editor);
    const dispatch = vi.spyOn(view, "dispatch");

    expect(controller.cancel).toHaveBeenCalledOnce();
    expect(applyFinal(editor, target, "dictated words")).toBe("changed");
    expect(dispatch).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("captured draft");
    expect(loadDraft(machineSessionKey("machine-a", "session-a"))).toBe("captured draft");
  });

  it("locks every composer-mutating control while leaving agent-work Stop available", () => {
    const editor = new PromptEditor();
    const onSend = vi.fn();
    const onCompact = vi.fn();
    const onModel = vi.fn();
    const onThinking = vi.fn();
    const onStop = vi.fn();
    editor.onSend = onSend;
    editor.onCompact = onCompact;
    editor.onSelectModel = onModel;
    editor.onSelectThinking = onThinking;
    editor.onStop = onStop;
    editor.showSessionConfiguration = true;
    editor.sessionConfiguration = { model: { provider: "openai", id: "gpt-test" }, thinkingLevel: "medium" };
    editor.canSteer = true;
    editor.canStop = true;
    Reflect.set(editor, "attachments", [pendingAttachment("attachment-1")]);
    setSpeechState(editor, { kind: "listening", runId: "run-1", provider: "browser", elapsedMs: 0 });

    const host = renderPromptEditor(editor);
    expect(requiredButton(host, ".editor-attach").disabled).toBe(true);
    expect(requiredButton(host, ".compact-button").disabled).toBe(true);
    expect(requiredButton(host, ".send-button").disabled).toBe(true);
    expect(requiredButton(host, ".steer-button").disabled).toBe(true);
    expect(requiredButton(host, ".attachment-remove").disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>(".attachment-delivery select")?.disabled).toBe(true);
    expect(requiredButton(host, ".select-model").disabled).toBe(true);
    expect(requiredButton(host, ".select-thinking").disabled).toBe(true);

    requiredButton(host, ".stop-button").click();
    expect(onStop).toHaveBeenCalledOnce();

    invokeVoid(editor, "send");
    expect(invokeEditorEnter(editor)).toBe(true);
    expect(invokeEditorTab(editor)).toBe(true);
    invokePick(editor, { kind: "command", replaceFrom: 0, replaceTo: 0, insertText: "/help" });
    invokeRemoveAttachment(editor, "attachment-1");
    invokeChangeDelivery(editor, "folder");
    invokeAddAttachments(editor, []);

    expect(onSend).not.toHaveBeenCalled();
    expect(onCompact).not.toHaveBeenCalled();
    expect(onModel).not.toHaveBeenCalled();
    expect(onThinking).not.toHaveBeenCalled();
    expect(pendingAttachments(editor)).toHaveLength(1);
  });

  it("adds and removes aria-readonly for dictation while preserving external disabled state", async () => {
    const editor = await mountedEditor({ sessionId: "session-a" });
    const view = requiredView(editor);

    setSpeechState(editor, { kind: "listening", runId: "run-1", provider: "browser", elapsedMs: 0 });
    invokeVoid(editor, "updateEditorDisabledState");
    let host = renderPromptEditor(editor);
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(host.querySelector(".markdown-editor")?.getAttribute("aria-readonly")).toBe("true");
    expect(host.querySelector(".markdown-editor")?.getAttribute("aria-disabled")).toBe("false");

    setSpeechState(editor, { kind: "idle", provider: "browser" });
    invokeVoid(editor, "updateEditorDisabledState");
    host = renderPromptEditor(editor);
    expect(view.state.facet(EditorState.readOnly)).toBe(false);
    expect(host.querySelector(".markdown-editor")?.hasAttribute("aria-readonly")).toBe(false);

    editor.disabled = true;
    invokeVoid(editor, "updateEditorDisabledState");
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(renderPromptEditor(editor).querySelector(".markdown-editor")?.getAttribute("aria-disabled")).toBe("true");
  });
});

async function mountedEditor(overrides: { sessionId?: string; speechInputSettings?: SpeechInputSettingsResponse } = {}): Promise<PromptEditor> {
  const editor = new PromptEditor();
  editor.machineId = "machine-a";
  editor.projectId = "project-a";
  editor.workspaceId = "workspace-a";
  if (overrides.sessionId !== undefined) editor.sessionId = overrides.sessionId;
  if (overrides.speechInputSettings !== undefined) editor.speechInputSettings = overrides.speechInputSettings;
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

function installControlledBrowserRecognition(): ControlledBrowserRecognition[] {
  const recognitions: ControlledBrowserRecognition[] = [];
  class TrackedBrowserRecognition extends ControlledBrowserRecognition {
    constructor() {
      super();
      recognitions.push(this);
    }
  }
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("SpeechRecognition", TrackedBrowserRecognition);
  return recognitions;
}

function requiredRecognition(recognitions: readonly ControlledBrowserRecognition[], index: number): ControlledBrowserRecognition {
  const recognition = recognitions[index];
  if (recognition === undefined) throw new Error(`Expected Browser recognition instance ${String(index)}`);
  return recognition;
}

function mountedSpeechInputButton(editor: PromptEditor): HTMLButtonElement {
  const shadowRoot = editor.shadowRoot;
  if (shadowRoot === null) throw new Error("PromptEditor shadow root was unavailable");
  return requiredButton(shadowRoot, ".speech-input-button");
}

function mountedEditorHost(editor: PromptEditor): HTMLDivElement {
  const host = editor.shadowRoot?.querySelector<HTMLDivElement>(".markdown-editor");
  if (host === null || host === undefined) throw new Error("PromptEditor editor host was unavailable");
  return host;
}

function requiredView(editor: PromptEditor) {
  const view = editor.view;
  if (view === undefined) throw new Error("PromptEditor CodeMirror view was unavailable");
  return view;
}

function captureTarget(editor: PromptEditor): SpeechInputTargetSnapshot | undefined {
  const value = invokeReflectedMethod(editor, "captureSpeechInputTarget");
  if (value === undefined) return undefined;
  if (!isSpeechInputTargetSnapshot(value)) throw new Error("PromptEditor returned an invalid speech target");
  return value;
}

function requiredTarget(editor: PromptEditor): SpeechInputTargetSnapshot {
  const target = captureTarget(editor);
  if (target === undefined) throw new Error("PromptEditor speech target was unavailable");
  return target;
}

function applyFinal(editor: PromptEditor, target: SpeechInputTargetSnapshot, text: string): "inserted" | "empty" | "changed" | "too-large" {
  const value = invokeReflectedMethod(editor, "applySpeechInputFinal", target, text);
  if (value === "inserted" || value === "empty" || value === "changed" || value === "too-large") return value;
  throw new Error("PromptEditor returned an invalid speech insertion outcome");
}

function applyInterim(editor: PromptEditor, target: SpeechInputTargetSnapshot, text: string): void {
  void invokeReflectedMethod(editor, "applySpeechInputInterim", target, text);
}

function setSpeechState(editor: PromptEditor, state: SpeechInputControllerState): void {
  Reflect.set(editor, "speechInputState", state);
}

function speechState(editor: PromptEditor): SpeechInputControllerState {
  const value: unknown = Reflect.get(editor, "speechInputState");
  if (!isSpeechInputState(value)) throw new Error("PromptEditor speech state was unavailable");
  return value;
}

function isSpeechInputState(value: unknown): value is SpeechInputControllerState {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "kind") === "string";
}

function installController(editor: PromptEditor): SpeechControllerReplacement {
  const controller: SpeechControllerReplacement = {
    configure: vi.fn<ConfigureSpeechController>(),
    start: vi.fn<StartSpeechController>(),
    stop: vi.fn<StopSpeechController>(),
    cancel: vi.fn<CancelSpeechController>(() => true),
    dispose: vi.fn<DisposeSpeechController>(),
  };
  Reflect.set(editor, "speechInputController", controller);
  return controller;
}

function updateProperty(editor: PromptEditor, property: "sessionId" | "machineId" | "projectId" | "workspaceId", value: string): void {
  let previous: string | undefined;
  switch (property) {
    case "sessionId":
      previous = editor.sessionId;
      editor.sessionId = value;
      break;
    case "machineId":
      previous = editor.machineId;
      editor.machineId = value;
      break;
    case "projectId":
      previous = editor.projectId;
      editor.projectId = value;
      break;
    case "workspaceId":
      previous = editor.workspaceId;
      editor.workspaceId = value;
      break;
  }
  const changed: PropertyValues<PromptEditor> = new Map();
  changed.set(property, previous);
  void invokeReflectedMethod(editor, "willUpdate", changed);
}

function renderPromptEditor(editor: PromptEditor): HTMLElement {
  const host = document.createElement("div");
  render(editor.render(), host);
  return host;
}

function requiredButton(root: ParentNode, selector: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`Expected ${selector} button`);
  return button;
}

function invokeVoid(editor: PromptEditor, name: string): void {
  void invokeReflectedMethod(editor, name);
}

function invokeEditorEnter(editor: PromptEditor): boolean {
  const value = invokeReflectedMethod(editor, "handleEditorEnter", {}, false);
  if (typeof value !== "boolean") throw new Error("PromptEditor Enter handler did not return a boolean");
  return value;
}

function invokeEditorTab(editor: PromptEditor): boolean {
  const value = invokeReflectedMethod(editor, "handleEditorTab", {});
  if (typeof value !== "boolean") throw new Error("PromptEditor Tab handler did not return a boolean");
  return value;
}

function invokePick(editor: PromptEditor, item: object): void {
  void invokeReflectedMethod(editor, "pick", item);
}

function invokeAddAttachments(editor: PromptEditor, files: File[]): void {
  void invokeReflectedMethod(editor, "addAttachmentFiles", files);
}

function invokeRemoveAttachment(editor: PromptEditor, id: string): void {
  void invokeReflectedMethod(editor, "removeAttachment", id);
}

function invokeChangeDelivery(editor: PromptEditor, value: string): void {
  const select = document.createElement("select");
  select.value = value;
  const onChange = (event: Event) => {
    void invokeReflectedMethod(editor, "changeDelivery", event);
  };
  select.addEventListener("change", onChange);
  select.dispatchEvent(new Event("change"));
  select.removeEventListener("change", onChange);
}

function pendingAttachments(editor: PromptEditor): PendingAttachment[] {
  const value: unknown = Reflect.get(editor, "attachments");
  if (!Array.isArray(value) || !value.every(isPendingAttachment)) throw new Error("PromptEditor attachments were unavailable");
  return value;
}

function isPendingAttachment(value: unknown): value is PendingAttachment {
  if (typeof value !== "object" || value === null) return false;
  return typeof Reflect.get(value, "id") === "string"
    && typeof Reflect.get(value, "name") === "string"
    && typeof Reflect.get(value, "mimeType") === "string"
    && typeof Reflect.get(value, "data") === "string"
    && typeof Reflect.get(value, "size") === "number";
}

function pendingAttachment(id: string): PendingAttachment {
  return { id, kind: "image", name: "note.png", mimeType: "image/png", data: "UE5H", size: 3 };
}

function invokeReflectedMethod(target: object, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function") throw new Error(`PromptEditor.${name} is not callable`);
  return Reflect.apply(method, target, args);
}

function isSpeechInputTargetSnapshot(value: unknown): value is SpeechInputTargetSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const identity: unknown = Reflect.get(value, "identity");
  return isSpeechInputComposerIdentity(identity)
    && typeof Reflect.get(value, "text") === "string"
    && Number.isInteger(Reflect.get(value, "from"))
    && Number.isInteger(Reflect.get(value, "to"));
}

function isSpeechInputComposerIdentity(value: unknown): value is SpeechInputTargetSnapshot["identity"] {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  const sharedParts = typeof Reflect.get(value, "machineId") === "string"
    && typeof Reflect.get(value, "projectId") === "string"
    && typeof Reflect.get(value, "workspaceId") === "string";
  if (!sharedParts) return false;
  return kind === "starter" || (kind === "session" && typeof Reflect.get(value, "sessionId") === "string");
}

function mediaQuery(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}
