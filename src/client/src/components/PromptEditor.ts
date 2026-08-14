import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from "@codemirror/commands";
import { markdown, deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultHighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, type FileSuggestion, type PromptAttachment, type SessionStatus, type SlashCommand, type SpeechInputSettingsResponse } from "../api";
import {
  type ClientSessionModelPolicyStatus,
  type ModelTier,
  type ModelTierSettingsResponse,
  type PromptAttachmentDelivery,
} from "../../../shared/apiTypes";
import { capturePromptAttachments, effectivePromptAttachmentDelivery, isInlinePromptAttachment, promptAttachmentsCanUseInlineDelivery } from "../promptAttachmentCapture";
import { promptAttachmentDrafts, PromptAttachmentDraftStore, type PendingAttachment, type PromptAttachmentDraft, type PromptAttachmentDraftScope } from "../promptAttachmentDrafts";
import { inputModeForDraft, inputModesEqual, type InputMode } from "../inputModes";
import { machineSessionKey } from "../machineKeys";
import { detectPromptCompletionTrigger, fileCompletionInsertText, type PromptCompletionTrigger } from "../promptCompletions";
import { clearDraft, loadDraft, saveDraft } from "../promptDraftStorage";
import { loadAttachmentDelivery, saveAttachmentDelivery } from "../attachmentPreferences";
import { createMobilePromptEnterMedia, readPromptEnterPreference, shouldSendPromptOnEnterShortcut, shouldUsePromptEnterShiftShortcut } from "../promptEnterBehavior";
import { createDefaultSpeechInputController, type SpeechInputControllerState } from "../controllers/speechInputController";
import { buildSpeechTranscriptInsertion, type SpeechInputComposerIdentity, type SpeechInputTargetSnapshot } from "../speechInput/speechInputCore";
import { clearPromptSpeechInterim, promptSpeechDecoration, showPromptSpeechInterim } from "./promptSpeechDecoration";
import { promptEditorStyles, type CompletionItem } from "./shared";
import { renderAttachIcon, renderCompactIcon, renderMicrophoneIcon, renderSendIcon, renderQueueIcon, renderSteerIcon, renderStopIcon, renderThinkingGauge, renderWaveformIcon } from "./promptEditorIcons";
import { thinkingGauge, thinkingLevelLabel } from "../../../shared/thinkingLevels";
import { TIER_LABELS } from "./modelPolicyLabels";
import type { ThinkingLevelOption } from "./thinkingLevelOptions";
import "./AutocompleteMenu";
import "./SessionModelPolicyControl";
import "./SessionThinkingMenu";
import "./SessionTierMenu";

@customElement("prompt-editor")
export class PromptEditor extends LitElement {
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) sendDisabled = false;
  @property() sessionId?: string;
  @property() cwd?: string;
  @property() machineId = "local";
  @property() projectId?: string;
  @property() workspaceId?: string;
  @property({ type: Boolean }) workspaceScopedFileSuggestions = false;
  @property({ type: Boolean }) canSteer = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Boolean }) canStop = false;
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Boolean }) sending = false;
  @property({ attribute: false }) onSend?: (text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery?: PromptAttachmentDelivery) => void | Promise<void>;
  @property({ attribute: false }) onStop?: () => void;
  @property({ attribute: false }) onSelectModel?: () => void;
  @property({ attribute: false }) onSelectThinking?: () => void;
  @property({ attribute: false }) onCompact?: () => void;
  /** Show model and thinking controls before a session exists (for the starter screen). */
  @property({ type: Boolean }) showSessionConfiguration = false;
  /** Persisted defaults shown by the starter before it has a session status. */
  @property({ attribute: false }) sessionConfiguration?: Pick<SessionStatus, "model" | "thinkingLevel">;
  @property({ attribute: false }) modelPolicyStatus?: ClientSessionModelPolicyStatus;
  @property({ attribute: false }) modelTierCatalog?: ModelTierSettingsResponse;
  @property({ attribute: false }) onSelectPolicyMode?: (mode: "exact" | "tiered") => void;
  @property({ attribute: false }) onSelectPolicyTier?: (tier: ModelTier) => void;
  @property({ attribute: false }) onSelectPolicyThinking?: (level: string) => void;
  @property({ attribute: false }) policyThinkingOptions: ThinkingLevelOption[] = [];
  @property({ type: Boolean }) modelPolicyLoading = false;
  @property({ type: Boolean }) modelPolicySaving = false;
  @property() modelPolicyError = "";
  @property({ attribute: false }) availableThinkingLevels: readonly string[] = [];
  @property({ attribute: false }) speechInputSettings?: SpeechInputSettingsResponse;
  /** Injectable so tests and the app share one app-lifetime draft store. */
  @property({ attribute: false }) attachmentDrafts: PromptAttachmentDraftStore = promptAttachmentDrafts;
  @query(".markdown-editor") private editorHost?: HTMLDivElement;
  @query(".attachment-input") private attachmentInput?: HTMLInputElement;
  // `draft` is the live document text but is intentionally NOT reactive: it
  // changes on every keystroke and the visible text is owned by CodeMirror, not
  // by Lit's render. Re-rendering the surrounding template on each keystroke is
  // wasted work and, on iOS, can interrupt an in-progress touch gesture (the
  // long-press edit/paste callout). Only `currentInputMode` (shell vs. normal)
  // is reactive, since that is the only draft-derived value the template shows.
  private draft = "";
  @state() private currentInputMode: InputMode = { kind: "normal" };
  @state() private completions: CompletionItem[] = [];
  @state() private selectedIndex = 0;
  @state() private attachments: PendingAttachment[] = [];
  @state() private attachmentDelivery: PromptAttachmentDelivery = loadAttachmentDelivery();
  @state() private attachmentError: string | undefined = undefined;
  @state() private speechInputState: SpeechInputControllerState = {
    kind: "idle",
    unavailableReason: "Speech settings are still loading.",
  };
  private attachmentScope: PromptAttachmentDraftScope | undefined;
  private requestVersion = 0;
  private editor: EditorView | undefined;
  private readonly editableCompartment = new Compartment();
  private readonly readOnlyCompartment = new Compartment();
  private readonly mobilePromptEnterMedia = createMobilePromptEnterMedia();
  private explicitShiftKeyActive = false;
  private speechInputController = createDefaultSpeechInputController({
    onStateChange: (state) => { this.handleSpeechInputStateChange(state); },
    onInterim: (target, text) => { this.applySpeechInputInterim(target, text); },
    onFinal: (target, text) => this.applySpeechInputFinal(target, text),
    onClearInterim: () => { this.clearSpeechInputInterim(); },
  });

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("disabled") && this.disabled && this.speechInputActive()) this.cancelSpeechInput();
    const identityChanged = changed.has("sessionId")
      || changed.has("machineId")
      || changed.has("projectId")
      || changed.has("workspaceId");
    if (identityChanged) {
      this.cancelSpeechInput();
      if (!changed.has("sessionId") && !changed.has("machineId")) return;
    }
    if (!changed.has("sessionId") && !changed.has("machineId")) return;
    const previousSessionId = changed.has("sessionId") ? changed.get("sessionId") : this.sessionId;
    const previousMachineId = changed.has("machineId") ? changed.get("machineId") : this.machineId;
    const previousKey = draftStorageKey(previousMachineId, previousSessionId);
    const previousScope = this.attachmentScope
      ?? (previousKey === undefined ? undefined : this.attachmentDrafts.findScope(previousKey));
    if (previousKey !== undefined) saveDraft(previousKey, this.draft);
    const currentKey = draftStorageKey(this.machineId, this.sessionId);
    // Park the outgoing session's unsent attachments before adopting the next
    // session's, so switching away never carries files into another session.
    // Only while the handle still owns the outgoing raw key and the rendered
    // mirror holds something: a migrated scope may already contain a capture
    // that completed before this lifecycle update, and parking the stale mirror
    // would overwrite it. Parking an empty mirror would delete a stored draft
    // the editor has not adopted via the store's empty-snapshot rule.
    if (
      previousKey !== undefined
      && previousKey !== currentKey
      && previousScope?.currentKey() === previousKey
      && (this.attachments.length > 0 || this.attachmentError !== undefined)
    ) {
      previousScope.write(this.currentAttachmentDraft());
    }
    this.draft = currentKey !== undefined ? loadDraft(currentKey) : "";
    const currentScope = currentKey === undefined ? undefined : this.attachmentDrafts.openScope(currentKey);
    this.attachmentScope = currentScope;
    this.adoptAttachmentDraft(currentScope?.read() ?? { attachments: [] });
    this.currentInputMode = inputModeForDraft(this.draft);
    this.completions = [];
    this.selectedIndex = 0;
  }

  protected override shouldUpdate(changed: PropertyValues<this>): boolean {
    // Status updates churn once per token during streaming and hand us a fresh
    // object reference each time. The separately supplied live policy projection
    // can be replaced in the same parent render, so treat those two inputs as one
    // status update and ignore it when every displayed field remains equal.
    if (
      changed.has("status")
      && [...changed.keys()].every((key) => key === "status" || key === "modelPolicyStatus")
    ) {
      const statusEqual = sessionStatusRenderEqual(changed.get("status"), this.status);
      const policyStatusEqual = !changed.has("modelPolicyStatus") || modelPolicyStatusRenderEqual(
        changed.get("modelPolicyStatus"),
        this.modelPolicyStatus,
      );
      return !statusEqual || !policyStatusEqual;
    }
    return true;
  }

  override firstUpdated(): void {
    this.createEditor();
  }

  protected override updated(changed: PropertyValues) {
    if (changed.has("speechInputSettings")) this.speechInputController.configure(this.speechInputSettings);
    if (changed.has("disabled") || changed.has("speechInputState")) this.updateEditorDisabledState();
    if (changed.has("sessionId") || changed.has("machineId")) this.syncEditorDoc();
  }

  override disconnectedCallback(): void {
    this.cancelSpeechInput();
    this.speechInputController.dispose();
    this.clearSpeechInputInterim();
    this.editor?.destroy();
    this.editor = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const shellInputMode = this.currentInputMode.kind === "shell" ? this.currentInputMode : undefined;
    const shellMode = shellInputMode !== undefined;
    const queuesInput = this.canSteer || this.isCompacting;
    const speechInputActive = this.speechInputActive();
    const busy = this.disabled || this.sending || speechInputActive;
    const sendBusy = busy || this.sendDisabled;
    // Manual compaction aborts current work. Keep it beside Queue, but do not
    // permit it while the session exposes a stop action.
    const compactDisabled = busy || this.canSteer || this.isCompacting || this.canStop;
    return html`
      <footer class=${shellMode ? "shell-mode" : ""} @paste=${(event: ClipboardEvent) => { void this.handlePaste(event); }} @dragover=${(event: DragEvent) => { this.handleDragOver(event); }} @drop=${(event: DragEvent) => { void this.handleDrop(event); }}>
        <div class="editor-wrap">
          <div class=${`markdown-editor${this.disabled ? " markdown-editor-disabled" : ""}`} aria-label="Message pi" aria-disabled=${this.disabled ? "true" : "false"} aria-readonly=${speechInputActive ? "true" : nothing}></div>
          <input class="attachment-input" type="file" multiple hidden @change=${(event: Event) => { void this.handleFileInput(event); }} />
          <button class="editor-attach icon-button" ?disabled=${busy} title="Attach files" aria-label="Attach files" @click=${() => { if (!this.speechInputActive()) this.attachmentInput?.click(); }}>${renderAttachIcon()}</button>
          ${shellMode ? html`<div class="mode-hint">Shell command${shellInputMode.excludeFromContext ? " · excluded from context" : ""}</div>` : null}
          ${this.isCompacting && !shellMode ? html`<div class="mode-hint">Compacting history · message will be queued</div>` : null}
          ${this.renderAttachments()}
          <autocomplete-menu .items=${this.completions} .selectedIndex=${this.selectedIndex} .onPick=${(item: CompletionItem) => { this.pick(item); }}></autocomplete-menu>
        </div>
        <div class="actions">
          ${this.renderCompactStatus()}
          ${this.renderSpeechInputStatus()}
          ${this.onCompact === undefined ? null : html`<button class="compact-button" ?disabled=${compactDisabled} title="Compact context" aria-label="Compact context" @click=${() => { if (!this.speechInputActive()) this.onCompact?.(); }}>${renderCompactIcon()}<span>Compact</span></button>`}
          ${this.renderSpeechInputButton()}
          <button class="icon-button send-button" ?disabled=${sendBusy} title=${queuesInput ? "Queue until the current activity finishes" : "Send message"} aria-label=${queuesInput ? "Queue message" : "Send message"} @click=${() => { this.send("followUp"); }}>${queuesInput ? renderQueueIcon() : renderSendIcon()}</button>
          ${this.canSteer && !this.isCompacting ? html`<button class="icon-button steer-button" ?disabled=${sendBusy} title="Steer the current response before the next model call" aria-label="Steer current response" @click=${() => { this.send("steer"); }}>${renderSteerIcon()}</button>` : null}
          <button class="icon-button stop-button" ?disabled=${this.disabled || !this.canStop} title=${this.canStop ? "Stop current work and clear queued messages" : "Nothing running"} aria-label="Stop current work" @click=${() => this.onStop?.()}>${renderStopIcon()}</button>
        </div>
        ${this.renderSpeechInputError()}
      </footer>
    `;
  }

  focusInput() {
    this.editor?.focus();
  }

  replaceText(text: string): void {
    this.draft = text;
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) saveDraft(key, text);

    const editor = this.editor;
    if (editor !== undefined) {
      const current = editor.state.doc.toString();
      editor.dispatch({
        ...(current === text ? {} : { changes: { from: 0, to: current.length, insert: text } }),
        selection: EditorSelection.cursor(text.length),
      });
    }

    // Invalidate completion requests started for either the previous document or
    // the replacement dispatch, then return the editor to a clean completion state.
    this.requestVersion += 1;
    this.currentInputMode = inputModeForDraft(text);
    this.completions = [];
    this.selectedIndex = 0;
  }

  /** Get the underlying CM6 EditorView, or undefined if not yet mounted. */
  get view(): EditorView | undefined {
    return this.editor;
  }

  /** Lets the app shell cancel the active dictation run before global shortcuts. */
  cancelSpeechInput(): boolean {
    return this.speechInputController.cancel();
  }

  private speechInputActive(): boolean {
    return this.speechInputState.kind !== "idle";
  }

  private handleSpeechInputStateChange(state: SpeechInputControllerState): void {
    const wasActive = this.speechInputActive();
    this.speechInputState = state;
    this.updateEditorDisabledState();
    if (wasActive && state.kind === "idle") {
      queueMicrotask(() => {
        if (!this.speechInputActive()) this.editor?.focus();
      });
    }
  }

  private handleSpeechInputControl(): void {
    switch (this.speechInputState.kind) {
      case "idle":
        if (!this.disabled) this.startSpeechInput();
        return;
      case "listening":
        this.speechInputController.stop();
        return;
      case "requesting-permission":
      case "transcribing":
        this.cancelSpeechInput();
        return;
    }
  }

  private startSpeechInput(): void {
    if (this.disabled) return;
    // Invalidate delayed completion responses before capturing the document and
    // selection. Starting dictation itself never changes the draft.
    this.requestVersion += 1;
    this.completions = [];
    this.selectedIndex = 0;
    this.clearSpeechInputInterim();
    const target = this.captureSpeechInputTarget();
    if (target === undefined) {
      this.speechInputState = {
        kind: "idle",
        ...(this.speechInputState.provider === undefined ? {} : { provider: this.speechInputState.provider }),
        error: "Speech input is unavailable for this composer.",
      };
      return;
    }
    this.speechInputController.start(target);
  }

  private captureSpeechInputTarget(): SpeechInputTargetSnapshot | undefined {
    const editor = this.editor;
    const identity = this.speechInputComposerIdentity();
    if (editor === undefined || identity === undefined) return undefined;
    const selection = editor.state.selection.main;
    return {
      identity,
      text: editor.state.doc.toString(),
      from: selection.from,
      to: selection.to,
    };
  }

  private speechInputComposerIdentity(): SpeechInputComposerIdentity | undefined {
    const machineId = nonemptySpeechIdentityPart(this.machineId);
    const projectId = nonemptySpeechIdentityPart(this.projectId);
    const workspaceId = nonemptySpeechIdentityPart(this.workspaceId);
    if (machineId === undefined || projectId === undefined || workspaceId === undefined) return undefined;

    const sessionId = this.sessionId;
    if (sessionId === undefined || sessionId === "") {
      return { kind: "starter", machineId, projectId, workspaceId };
    }
    if (typeof sessionId !== "string") return undefined;
    return { kind: "session", machineId, projectId, workspaceId, sessionId };
  }

  private speechInputTargetIsCurrent(target: SpeechInputTargetSnapshot): boolean {
    const identity = this.speechInputComposerIdentity();
    const editor = this.editor;
    return !this.disabled
      && identity !== undefined
      && editor !== undefined
      && sameSpeechInputComposerIdentity(identity, target.identity)
      && editor.state.doc.toString() === target.text;
  }

  private applySpeechInputInterim(target: SpeechInputTargetSnapshot, text: string): void {
    if (!this.speechInputTargetIsCurrent(target)) return;
    this.editor?.dispatch({
      effects: text === ""
        ? clearPromptSpeechInterim.of(undefined)
        : showPromptSpeechInterim.of({ from: target.from, to: target.to, text }),
    });
  }

  private applySpeechInputFinal(target: SpeechInputTargetSnapshot, text: string): "inserted" | "empty" | "changed" | "too-large" {
    const editor = this.editor;
    if (editor === undefined || !this.speechInputTargetIsCurrent(target)) return "changed";
    const insertion = buildSpeechTranscriptInsertion(target, editor.state.doc.toString(), text);
    if (!insertion.ok) return insertion.reason;
    editor.dispatch({
      changes: { from: insertion.from, to: insertion.to, insert: insertion.insert },
      selection: EditorSelection.cursor(insertion.caret),
      effects: clearPromptSpeechInterim.of(undefined),
    });
    return "inserted";
  }

  private clearSpeechInputInterim(): void {
    this.editor?.dispatch({ effects: clearPromptSpeechInterim.of(undefined) });
  }

  private renderSpeechInputButton() {
    const state = this.speechInputState;
    if (state.kind === "idle") {
      const unavailableReason = this.disabled
        ? "Dictation is unavailable while this prompt is disabled."
        : state.unavailableReason;
      const label = unavailableReason
        ?? (state.provider === undefined ? "Start dictation" : `Start dictation · ${speechInputProviderLabel(state.provider)}`);
      return html`<button class="icon-button speech-input-button speech-input-idle" ?disabled=${unavailableReason !== undefined} title=${label} aria-label=${label} @click=${() => { this.handleSpeechInputControl(); }}>${renderMicrophoneIcon()}</button>`;
    }
    if (state.kind === "requesting-permission") {
      const label = `Cancel dictation · ${speechInputProviderLabel(state.provider)}`;
      return html`<button class="icon-button speech-input-button speech-input-requesting" title=${label} aria-label=${label} @click=${() => { this.handleSpeechInputControl(); }}>${renderMicrophoneIcon()}</button>`;
    }
    if (state.kind === "listening") {
      const label = `Stop dictation · ${speechInputProviderLabel(state.provider)}`;
      return html`<button class="icon-button speech-input-button speech-input-listening" title=${label} aria-label=${label} @click=${() => { this.handleSpeechInputControl(); }}>${renderStopIcon()}</button>`;
    }
    const label = "Cancel transcription · Cloud";
    return html`<button class="icon-button speech-input-button speech-input-transcribing" title=${label} aria-label=${label} @click=${() => { this.handleSpeechInputControl(); }}>${renderWaveformIcon()}</button>`;
  }

  private renderSpeechInputStatus() {
    const state = this.speechInputState;
    if (state.kind === "idle") return null;
    if (state.kind === "requesting-permission") {
      return html`<div class="speech-input-status">Requesting microphone permission · ${speechInputProviderLabel(state.provider)}</div>`;
    }
    if (state.kind === "listening") {
      const elapsed = state.provider === "cloud" ? ` · ${speechInputElapsedLabel(state.elapsedMs)}` : "";
      return html`<div class="speech-input-status">Listening · ${speechInputProviderLabel(state.provider)}${elapsed}</div>`;
    }
    return html`<div class="speech-input-status">Transcribing · Cloud</div>`;
  }

  private renderSpeechInputError() {
    const error = this.speechInputState.kind === "idle" ? this.speechInputState.error : undefined;
    return error === undefined || error === "" ? null : html`<div class="speech-input-error" aria-live="polite">${error}</div>`;
  }

  private renderCompactStatus() {
    const configurationMode = this.status === undefined && this.showSessionConfiguration;
    const status = this.status ?? (configurationMode ? this.sessionConfiguration : undefined);
    if (status === undefined && !configurationMode) return null;
    const policyStatus = this.modelPolicyStatus ?? this.status?.modelPolicy;
    const model = status?.model?.id ?? (configurationMode ? "Choose default model" : "no model");
    const provider = status?.model?.provider !== undefined && status.model.provider !== "" ? `${status.model.provider}/` : "";
    const thinkingLabel = configurationMode
      ? `Default thinking level: ${thinkingLevelLabel(status?.thinkingLevel)}`
      : `Thinking level: ${thinkingLevelLabel(status?.thinkingLevel)}`;
    const policyEditable = !this.disabled && !this.speechInputActive() && !this.modelPolicySaving && !sessionHasActiveWork(this.status);
    return html`
      <div class="compact-status" aria-label=${configurationMode ? "Session defaults" : "Session status"}>
        ${policyStatus === undefined ? null : html`
          <session-model-policy-control
            .status=${policyStatus}
            .catalog=${this.modelTierCatalog}
            .loading=${this.modelPolicyLoading}
            .saving=${this.modelPolicySaving}
            .editable=${policyEditable}
            .error=${this.modelPolicyError}
            .onSelectMode=${this.onSelectPolicyMode === undefined ? undefined : (mode: "exact" | "tiered") => { if (!this.speechInputActive()) this.onSelectPolicyMode?.(mode); }}
          ></session-model-policy-control>
        `}
        ${policyStatus?.mode === "tiered" ? html`
          <session-tier-menu
            .catalog=${this.modelTierCatalog}
            .selectedTier=${policyStatus.tier}
            .label=${policyStatus.tier === undefined ? "Choose tier" : TIER_LABELS[policyStatus.tier]}
            .editable=${policyEditable}
            .onSelectTier=${this.onSelectPolicyTier === undefined ? undefined : (tier: ModelTier) => { if (!this.speechInputActive()) this.onSelectPolicyTier?.(tier); }}
          ></session-tier-menu>
        ` : html`
          <button class="select-model" ?disabled=${this.onSelectModel === undefined || this.speechInputActive()} title="Select model" @click=${() => { if (!this.speechInputActive()) this.onSelectModel?.(); }}>${provider}${model}</button>
          ${policyStatus === undefined ? html`
            <button class="select-thinking icon-button" ?disabled=${this.onSelectThinking === undefined || this.speechInputActive()} title=${thinkingLabel} aria-label=${thinkingLabel} @click=${() => { if (!this.speechInputActive()) this.onSelectThinking?.(); }}>${renderThinkingGauge(thinkingGauge(status?.thinkingLevel, this.availableThinkingLevels))}</button>
          ` : html`
            <session-thinking-menu
              .options=${this.policyThinkingOptions}
              .label=${policyStatus.resolved.thinkingLevel}
              .editable=${policyEditable}
              .onSelectLevel=${this.onSelectPolicyThinking === undefined ? undefined : (level: string) => { if (!this.speechInputActive()) this.onSelectPolicyThinking?.(level); }}
            ></session-thinking-menu>
          `}
        `}
      </div>
    `;
  }

  private renderAttachments() {
    if (this.attachments.length === 0 && this.attachmentError === undefined) return null;
    const canUseInlineDelivery = promptAttachmentsCanUseInlineDelivery(this.attachments);
    const delivery = this.effectiveAttachmentDelivery();
    const locked = this.speechInputActive();
    return html`
      <div class="attachments" aria-label="Pending attachments">
        ${this.attachments.map((attachment) => html`
          <div class=${`attachment-chip ${isInlinePromptAttachment(attachment) ? "attachment-chip-image" : "attachment-chip-file"}`} title=${attachment.name}>
            ${this.renderAttachmentPreview(attachment)}
            <button type="button" class="attachment-remove" ?disabled=${locked} title="Remove attachment" aria-label=${`Remove ${attachment.name}`} @click=${() => { this.removeAttachment(attachment.id); }}>×</button>
          </div>
        `)}
        ${this.attachments.length > 0 ? html`
          <label class="attachment-delivery" title=${canUseInlineDelivery ? "How attachments are delivered to the agent" : "General files are saved and mentioned from the workspace"}>
            <select ?disabled=${locked} .value=${delivery} @change=${(event: Event) => { this.changeDelivery(event); }}>
              <option value="inline" ?disabled=${!canUseInlineDelivery}>Attach to message${canUseInlineDelivery ? "" : " (images only)"}</option>
              <option value="folder">Save to .pi-webui/attachments</option>
            </select>
          </label>
        ` : null}
        ${this.attachmentError !== undefined ? html`<div class="attachment-error">${this.attachmentError}</div>` : null}
      </div>
    `;
  }

  private renderAttachmentPreview(attachment: PendingAttachment) {
    if (isInlinePromptAttachment(attachment)) {
      return html`<img src=${`data:${attachment.mimeType};base64,${attachment.data}`} alt=${attachment.name} />`;
    }
    return html`
      <div class="attachment-file-preview" aria-hidden="true">${fileExtensionLabel(attachment.name)}</div>
      <span class="attachment-file-name">${attachment.name}</span>
    `;
  }

  private changeDelivery(event: Event) {
    if (this.speechInputActive()) return;
    if (!(event.target instanceof HTMLSelectElement)) return;
    const requested = event.target.value === "folder" ? "folder" : "inline";
    if (requested === "inline" && !promptAttachmentsCanUseInlineDelivery(this.attachments)) {
      event.target.value = "folder";
      return;
    }
    this.attachmentDelivery = requested;
    saveAttachmentDelivery(this.attachmentDelivery);
  }

  /** The active draft key, or `undefined` for the starter composer. */
  private attachmentScopeKey(): string | undefined {
    return draftStorageKey(this.machineId, this.sessionId);
  }

  private activeAttachmentScope(): PromptAttachmentDraftScope | undefined {
    const key = this.attachmentScopeKey();
    if (key === undefined) return undefined;
    if (this.attachmentScope?.currentKey() !== undefined) return this.attachmentScope;
    this.attachmentScope = this.attachmentDrafts.openScope(key);
    return this.attachmentScope;
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
    const scope = this.activeAttachmentScope();
    if (scope === undefined) return;
    scope.write(this.currentAttachmentDraft());
  }

  private removeAttachment(id: string) {
    if (this.speechInputActive()) return;
    this.attachments = this.attachments.filter((attachment) => attachment.id !== id);
    this.persistAttachmentDraft();
  }

  private async handlePaste(event: ClipboardEvent) {
    if (this.speechInputActive()) return;
    const files = filesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    await this.addAttachmentFiles(files);
  }

  private handleDragOver(event: DragEvent) {
    if (this.speechInputActive()) return;
    if (event.dataTransfer === null) return;
    if (dataTransferHasFiles(event.dataTransfer)) event.preventDefault();
  }

  private async handleDrop(event: DragEvent) {
    if (this.speechInputActive()) return;
    const files = filesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    await this.addAttachmentFiles(files);
  }

  private async handleFileInput(event: Event) {
    if (this.speechInputActive()) return;
    if (!(event.target instanceof HTMLInputElement) || event.target.files === null) return;
    const files = Array.from(event.target.files);
    event.target.value = "";
    await this.addAttachmentFiles(files);
  }

  private async addAttachmentFiles(files: File[]) {
    if (this.speechInputActive()) return;
    // Capture the scope before awaiting: the user may select another session
    // while the read is outstanding, and these bytes belong to the session that
    // was active when they were dropped, pasted, or picked.
    const scope = this.activeAttachmentScope();
    if (scope === undefined) {
      this.attachmentError = undefined;
      const starter = await capturePromptAttachments(files, readFileAsBase64);
      if (starter.attachments.length > 0) {
        this.attachments = [...this.attachments, ...starter.attachments.map((attachment) => ({ id: this.attachmentDrafts.nextAttachmentId(), ...attachment }))];
      }
      this.attachmentError = starter.error;
      return;
    }

    this.attachmentError = undefined;
    const capture = scope.beginCapture();
    const { attachments, error } = await capturePromptAttachments(files, readFileAsBase64);
    // The capture handle follows move() and becomes inert after clear(), so a
    // late read cannot recreate an obsolete source key.
    const merged = capture.complete(attachments, error);
    if (merged === undefined) return;
    if (scope.currentKey() !== this.attachmentScopeKey()) return;
    this.adoptAttachmentDraft(merged);
  }

  private currentAttachments(): PromptAttachment[] {
    return this.attachments.map((attachment) => pendingToPromptAttachment(attachment));
  }

  private effectiveAttachmentDelivery(): PromptAttachmentDelivery {
    return effectivePromptAttachmentDelivery(this.attachmentDelivery, this.attachments);
  }

  private createEditor() {
    if (!this.editorHost || this.editor !== undefined) return;
    this.editor = new EditorView({
      parent: this.editorHost,
      state: EditorState.create({
        doc: this.draft,
        extensions: [
          history(),
          markdown(),
          indentOnInput(),
          indentUnit.of("  "),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of((view) => inputAssistanceContentAttributes(view.state.sliceDoc(0, view.state.selection.main.head))),
          EditorView.domEventHandlers({
            keyup: (event) => this.handleEditorKeyUp(event),
            blur: () => this.resetEditorModifierState(),
          }),
          placeholder("Message pi... Use / for commands, @ for tracked files, @ space for all files"),
          promptSpeechDecoration,
          this.editableCompartment.of(EditorView.editable.of(!(this.disabled || this.speechInputState.kind !== "idle"))),
          this.readOnlyCompartment.of(EditorState.readOnly.of(this.disabled || this.speechInputState.kind !== "idle")),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.updateDraft(update.state.doc.toString());
          }),
          keymap.of([
            { any: (view, event) => this.handleEditorKeyDown(event, view) },
            { key: "ArrowDown", run: () => this.moveCompletion(1) },
            { key: "ArrowUp", run: () => this.moveCompletion(-1) },
            { key: "Escape", run: () => this.closeCompletions() },
            { key: "Tab", run: (view) => this.handleEditorTab(view) },
            { key: "Shift-Tab", run: (view) => indentWithTab.shift?.(view) ?? false },
            { key: "Backspace", run: (view) => deleteMarkupBackward(view) },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
        ],
      }),
    });
  }

  private syncEditorDoc() {
    const editor = this.editor;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === this.draft) return;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: this.draft },
      selection: EditorSelection.cursor(this.draft.length),
    });
  }

  private updateEditorDisabledState() {
    const readOnly = this.disabled || this.speechInputState.kind !== "idle";
    this.editor?.dispatch({
      effects: [
        this.editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
        this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
      ],
    });
  }

  private updateDraft(value: string) {
    this.draft = value;
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) saveDraft(key, this.draft);
    const nextInputMode = inputModeForDraft(this.draft);
    if (!inputModesEqual(nextInputMode, this.currentInputMode)) this.currentInputMode = nextInputMode;
    void this.refreshCompletions();
  }

  private async refreshCompletions() {
    const trigger = this.currentTrigger();
    const version = ++this.requestVersion;
    this.selectedIndex = 0;
    if (trigger === undefined) {
      this.completions = [];
      return;
    }
    if (trigger.kind === "command" && this.sessionId !== undefined && this.sessionId !== "" && this.cwd !== undefined && this.cwd !== "") {
      const commands = await api.commands({ id: this.sessionId, cwd: this.cwd }, this.machineId).catch(emptySlashCommands);
      if (version !== this.requestVersion) return;
      this.completions = commands
        .filter((command) => command.name.toLowerCase().includes(trigger.query.toLowerCase()))
        .slice(0, 12)
        .map((command) => ({
          kind: "command",
          replaceFrom: trigger.from,
          replaceTo: trigger.to,
          insertText: `/${command.name}`,
          detail: command.source,
          ...(command.description === undefined ? {} : { description: command.description }),
        }));
    } else if (trigger.kind === "file" && this.cwd !== undefined && this.cwd !== "") {
      const files = await api.files(this.cwd, trigger.query, { scope: trigger.fileScope, machineId: this.machineId, projectId: this.projectId, workspaceId: this.workspaceId, workspaceScoped: this.workspaceScopedFileSuggestions }).catch(emptyFileSuggestions);
      if (version !== this.requestVersion) return;
      this.completions = files
        .slice(0, 12)
        .map((file) => {
          const insertText = fileCompletionInsertText(file.path, trigger.quoted === true, file.path.endsWith("/") ? trigger.allPrefix : undefined);
          return {
            kind: "file",
            replaceFrom: trigger.from,
            replaceTo: trigger.to,
            insertText,
            detail: file.kind,
            ...(file.path.endsWith("/") && insertText.endsWith("\"") ? { cursorOffset: insertText.length - 1 } : {}),
          };
        });
    }
  }

  private currentTrigger(): PromptCompletionTrigger | undefined {
    return detectPromptCompletionTrigger(this.draft, this.editor?.state.selection.main.head ?? this.draft.length);
  }

  private moveCompletion(delta: number): boolean {
    if (!this.completions.length) return false;
    this.selectedIndex = (this.selectedIndex + delta + this.completions.length) % this.completions.length;
    return true;
  }

  private closeCompletions(): boolean {
    if (!this.completions.length) return false;
    this.completions = [];
    return true;
  }

  private handleEditorKeyDown(event: KeyboardEvent, view: EditorView): boolean {
    if (this.speechInputActive() && (event.key === "Enter" || event.key === "Tab")) return true;
    if (event.key === "Shift") {
      this.explicitShiftKeyActive = true;
      return false;
    }
    if (event.key !== "Enter") {
      this.explicitShiftKeyActive = false;
      return false;
    }
    if (event.defaultPrevented || event.isComposing || view.composing) return false;

    const shiftKey = shouldUsePromptEnterShiftShortcut(event.shiftKey, this.explicitShiftKeyActive, this.mobilePromptEnterMedia);
    this.explicitShiftKeyActive = false;
    return this.handleEditorEnter(view, shiftKey);
  }

  private handleEditorKeyUp(event: KeyboardEvent): boolean {
    if (event.key === "Shift") this.explicitShiftKeyActive = false;
    return false;
  }

  private resetEditorModifierState(): boolean {
    this.explicitShiftKeyActive = false;
    return false;
  }

  private handleEditorEnter(view: EditorView, shiftKey: boolean): boolean {
    if (this.speechInputActive()) return true;
    if (!shiftKey && this.completions.length) {
      const completion = this.completions[this.selectedIndex];
      if (completion !== undefined) this.pick(completion);
      return true;
    }
    if (!shouldSendPromptOnEnterShortcut(shiftKey, this.mobilePromptEnterMedia, readPromptEnterPreference())) {
      return insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);
    }
    this.send(this.canSteer || this.isCompacting ? "followUp" : undefined);
    return true;
  }

  private handleEditorTab(view: EditorView): boolean {
    if (this.speechInputActive()) return true;
    if (this.completions.length) {
      const completion = this.completions[this.selectedIndex];
      if (completion !== undefined) this.pick(completion);
      return true;
    }
    const trigger = this.currentTrigger();
    if (trigger?.kind === "file") {
      void this.refreshCompletions();
      return true;
    }
    return indentWithTab.run?.(view) ?? false;
  }

  private pick(item: CompletionItem) {
    if (this.speechInputActive()) return;
    const editor = this.editor;
    if (!editor) return;
    const suffix = item.kind === "file" && (item.insertText.endsWith("/") || item.cursorOffset !== undefined) ? "" : " ";
    const cursor = item.replaceFrom + (item.cursorOffset ?? item.insertText.length) + suffix.length;
    const replaceTo = item.insertText.endsWith("\"") && this.draft.slice(item.replaceTo).startsWith("\"") ? item.replaceTo + 1 : item.replaceTo;
    editor.dispatch({
      changes: { from: item.replaceFrom, to: replaceTo, insert: `${item.insertText}${suffix}` },
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
    });
    this.completions = [];
  }

  private send(streamingBehavior?: "steer" | "followUp") {
    if (this.speechInputActive() || this.disabled || this.sending || this.sendDisabled) return;
    const text = this.draft.trim();
    const pending = this.attachments;
    if (text === "" && pending.length === 0) return;
    const behavior = this.canSteer || this.isCompacting ? streamingBehavior : undefined;
    const attachments = pending.length > 0 ? this.currentAttachments() : undefined;
    const delivery = this.effectiveAttachmentDelivery();
    this.resetComposer();
    // Sending is owned by the controller (it drives the chat activity dock and,
    // for folder mode, orchestrates the upload + reference rewrite), so this is
    // fire-and-forget here.
    void this.onSend?.(text, behavior, attachments, attachments === undefined ? undefined : delivery);
  }

  private resetComposer() {
    this.draft = "";
    this.currentInputMode = { kind: "normal" };
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) clearDraft(key);
    const scope = key === undefined ? undefined : this.activeAttachmentScope();
    if (scope !== undefined) scope.clear();
    this.attachmentScope = undefined;
    this.completions = [];
    this.attachments = [];
    this.attachmentError = undefined;
    // `draft` is not reactive, so the cleared text will not flow to CodeMirror
    // via `updated()`; push it to the editor document explicitly.
    this.syncEditorDoc();
  }

  static override styles = promptEditorStyles;
}

function nonemptySpeechIdentityPart(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function sameSpeechInputComposerIdentity(
  left: SpeechInputComposerIdentity,
  right: SpeechInputComposerIdentity,
): boolean {
  if (left.kind !== right.kind) return false;
  if (
    left.machineId !== right.machineId
    || left.projectId !== right.projectId
    || left.workspaceId !== right.workspaceId
  ) {
    return false;
  }
  if (left.kind === "starter") return true;
  return right.kind === "session" && left.sessionId === right.sessionId;
}

function speechInputProviderLabel(provider: "browser" | "cloud"): "Browser" | "Cloud" {
  return provider === "browser" ? "Browser" : "Cloud";
}

function speechInputElapsedLabel(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// `status` churns once per token while the compact row only displays model,
// thinking, policy status, and whether active work makes policy mutation
// unavailable. Comparing those projections keeps meaningful policy changes
// visible without disturbing the editor DOM for unrelated token/cost updates.
function sessionStatusRenderEqual(a: SessionStatus | undefined, b: SessionStatus | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.model?.id === b.model?.id
    && a.model?.provider === b.model?.provider
    && a.thinkingLevel === b.thinkingLevel
    && modelPolicyStatusRenderEqual(a.modelPolicy, b.modelPolicy)
    && sessionHasActiveWork(a) === sessionHasActiveWork(b);
}

function modelPolicyStatusRenderEqual(
  a: ClientSessionModelPolicyStatus | undefined,
  b: ClientSessionModelPolicyStatus | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.mode === b.mode
    && a.tier === b.tier
    && a.resolved.model.provider === b.resolved.model.provider
    && a.resolved.model.id === b.resolved.model.id
    && a.resolved.thinkingLevel === b.resolved.thinkingLevel
    && a.ladderValid === b.ladderValid
    && a.blockedReason === b.blockedReason;
}

function sessionHasActiveWork(status: SessionStatus | undefined): boolean {
  return status?.isStreaming === true
    || status?.isBashRunning === true
    || status?.isCompacting === true
    || (status?.pendingMessageCount ?? 0) > 0;
}

function draftStorageKey(machineId: unknown, sessionId: unknown): string | undefined {
  if (typeof machineId !== "string" || machineId === "") return undefined;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  return machineSessionKey(machineId, sessionId);
}

function emptySlashCommands(): SlashCommand[] {
  return [];
}

function emptyFileSuggestions(): FileSuggestion[] {
  return [];
}

function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (data === null) return [];
  return Array.from(data.files);
}

function dataTransferHasFiles(data: DataTransfer): boolean {
  const items = Array.from(data.items);
  if (items.length > 0) return items.some((item) => item.kind === "file");
  return Array.from(data.types).includes("Files");
}

function pendingToPromptAttachment(attachment: PendingAttachment): PromptAttachment {
  if (attachment.kind === "image") {
    return { kind: "image", mimeType: attachment.mimeType, data: attachment.data, name: attachment.name };
  }
  return { kind: "file", mimeType: attachment.mimeType, data: attachment.data, name: attachment.name };
}

function fileExtensionLabel(name: string): string {
  const trimmed = name.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex >= 0 && dotIndex < trimmed.length - 1) return trimmed.slice(dotIndex + 1, dotIndex + 5).toUpperCase();
  return "FILE";
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => { reject(reader.error ?? new Error("Failed to read file")); };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") { reject(new Error("Unexpected file reader result")); return; }
      const commaIndex = result.indexOf(",");
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
    };
    reader.readAsDataURL(file);
  });
}

const proseInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "true",
  autocorrect: "on",
  autocapitalize: "sentences",
  writingsuggestions: "true",
  dir: "auto",
};

const codeLikeInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "false",
  autocorrect: "off",
  autocapitalize: "off",
  writingsuggestions: "false",
  dir: "auto",
};

function inputAssistanceContentAttributes(draftBeforeCursor: string): Record<string, string> {
  // CodeMirror is optimized for code and disables these by default, but the chat prompt is usually prose.
  return inputModeForDraft(draftBeforeCursor).kind === "normal" ? proseInputAssistanceAttributes : codeLikeInputAssistanceAttributes;
}
