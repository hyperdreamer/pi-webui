import type { ActivityRailContext } from "@hyperdreamer/pi-webui/plugin-api";
import type { LearnedSkill, LearnedSkillsWorkspaceState } from "./learnedSkillsData.js";
import {
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  clampLearnedSkillsListWidth,
  readLearnedSkillsListWidth,
  writeLearnedSkillsListWidth,
} from "./learnedSkillsPanelLayout.js";

export const learnedSkillsPanelTagName = "pi-webui-learned-skills-panel";

type SkillScope = "project" | "global";

interface SelectedSkill {
  scope: SkillScope;
  skill: LearnedSkill;
}

interface PointerInteraction {
  pointerId: number;
  startX: number;
  startWidth: number;
  divider: HTMLElement;
}

export function learnedSkillsBadge(state: LearnedSkillsWorkspaceState): number | undefined {
  if (state.kind !== "data") return undefined;
  const total = state.globalSkills.length + state.projectSkills.length;
  return total > 0 ? total : undefined;
}

export function isLearnedSkillsPanelVisible(state: LearnedSkillsWorkspaceState): boolean {
  return state.kind !== "unavailable";
}

export function defineLearnedSkillsPanelElement(): void {
  if (typeof customElements !== "undefined" && !customElements.get(learnedSkillsPanelTagName)) {
    customElements.define(learnedSkillsPanelTagName, PiWebUiLearnedSkillsPanel);
  }
}

// Keep the plugin importable in the Node-based contribution tests, where the
// browser element globals are intentionally absent.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class NoopElement {}

function noopElementConstructor(): typeof HTMLElement {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return NoopElement as unknown as typeof HTMLElement;
}

const BaseElement: typeof HTMLElement = typeof HTMLElement === "undefined"
  ? noopElementConstructor()
  : HTMLElement;

class PiWebUiLearnedSkillsPanel extends BaseElement {
  private state: LearnedSkillsWorkspaceState = { kind: "loading" };
  private retry: (() => void) | undefined;
  private selectedSkillId: string | undefined;
  private showMobileDetail = false;
  private pointerInteraction: PointerInteraction | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private connected = false;
  private preferredListWidth: number;
  public listWidth: number;
  private readonly root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.preferredListWidth = readLearnedSkillsListWidth();
    this.listWidth = this.preferredListWidth;
  }

  set context(_value: ActivityRailContext | undefined) {
    // Activity Rail supplies context for the host boundary. The panel reads
    // only the already-shaped snapshot and retry callback below.
  }

  set learnedSkillsState(value: LearnedSkillsWorkspaceState) {
    if (this.state === value) return;
    this.state = value;
    this.reconcileSelection();
    this.render();
  }

  set onRetry(value: (() => void) | undefined) {
    this.retry = value;
  }

  connectedCallback(): void {
    if (this.connected) return;
    this.connected = true;
    if (typeof window !== "undefined") {
      window.addEventListener("resize", this.handleWindowResize);
      window.addEventListener("pointermove", this.handlePointerMove);
      window.addEventListener("pointerup", this.handlePointerUp);
      window.addEventListener("pointercancel", this.handlePointerCancel);
    }
    this.render();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.handleObservedResize);
      this.resizeObserver.observe(this);
    }
  }

  disconnectedCallback(): void {
    this.finishPointerInteraction(false);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    if (this.connected && typeof window !== "undefined") {
      window.removeEventListener("resize", this.handleWindowResize);
      window.removeEventListener("pointermove", this.handlePointerMove);
      window.removeEventListener("pointerup", this.handlePointerUp);
      window.removeEventListener("pointercancel", this.handlePointerCancel);
    }
    this.connected = false;
  }

  private readonly handleObservedResize: ResizeObserverCallback = () => {
    if (this.connected) this.handleWindowResize();
  };

  private readonly handleWindowResize = (): void => {
    if (this.pointerInteraction === undefined) this.applyPreferredListWidth();
    else this.updateSeparator();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const divider = event.currentTarget;
    if (!(divider instanceof HTMLElement)) return;

    event.preventDefault();
    this.finishPointerInteraction(false);
    this.pointerInteraction = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: this.listWidth,
      divider,
    };
    divider.classList.add("dragging");
    callPointerMethod(divider, "setPointerCapture", event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const interaction = this.pointerInteraction;
    if (interaction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.updatePreferredListWidth(interaction.startWidth + event.clientX - interaction.startX);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.pointerInteraction?.pointerId !== event.pointerId) return;
    this.finishPointerInteraction(true);
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.pointerInteraction?.pointerId !== event.pointerId) return;
    this.finishPointerInteraction(false);
  };

  private render(): void {
    this.finishPointerInteraction(false);
    this.applyPreferredListWidth();
    this.root.innerHTML = `${panelStyles()}${renderPanelState(this.state, this.selectedSkillId, this.showMobileDetail)}`;
    this.attachEventListeners();
    this.updateSeparator();
  }

  private attachEventListeners(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-retry]")) {
      button.addEventListener("click", () => { this.retry?.(); });
    }

    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-skill-key]")) {
      button.addEventListener("click", () => {
        const key = button.dataset["skillKey"];
        if (key !== undefined) this.selectSkill(key);
      });
    }

    this.root.querySelector<HTMLButtonElement>("button[data-back]")?.addEventListener("click", () => {
      this.showMobileDetail = false;
      this.render();
    });

    const divider = this.root.querySelector<HTMLElement>("[role=separator]");
    divider?.addEventListener("pointerdown", this.handlePointerDown);
    divider?.addEventListener("keydown", this.handleDividerKeyDown);
  }

  private readonly handleDividerKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 72 : 24;
    let nextWidth: number | undefined;
    if (event.key === "ArrowLeft") nextWidth = this.listWidth - step;
    else if (event.key === "ArrowRight") nextWidth = this.listWidth + step;
    else if (event.key === "Home") nextWidth = MIN_LIST_WIDTH;
    else if (event.key === "End") nextWidth = this.runtimeMaximumWidth();
    if (nextWidth === undefined) return;

    event.preventDefault();
    this.updatePreferredListWidth(nextWidth, true);
  };

  private selectSkill(key: string): void {
    if (findSelectedSkill(this.state, key) === undefined) return;
    this.selectedSkillId = key;
    this.showMobileDetail = true;
    this.render();
  }

  private reconcileSelection(): void {
    if (this.selectedSkillId !== undefined && findSelectedSkill(this.state, this.selectedSkillId) !== undefined) return;
    this.selectedSkillId = undefined;
    this.showMobileDetail = false;
  }

  private applyPreferredListWidth(): void {
    this.applyEffectiveListWidth(this.preferredListWidth);
  }

  private applyEffectiveListWidth(width: number): void {
    const containerWidth = this.isNarrowViewport() ? undefined : this.knownContainerWidth();
    this.listWidth = clampLearnedSkillsListWidth(width, containerWidth);
    this.style.setProperty("--learned-skills-list-width", `${String(this.listWidth)}px`);
    this.updateSeparator();
  }

  private updatePreferredListWidth(width: number, persist = false): void {
    this.applyEffectiveListWidth(width);
    this.preferredListWidth = this.listWidth;
    if (persist) writeLearnedSkillsListWidth(this.preferredListWidth);
  }

  private updateSeparator(): void {
    const divider = this.root.querySelector<HTMLElement>("[role=separator]");
    if (divider === null) return;
    divider.setAttribute("aria-valuenow", String(this.listWidth));
    divider.setAttribute("aria-valuemax", String(this.runtimeMaximumWidth()));
  }

  private runtimeMaximumWidth(): number {
    if (this.isNarrowViewport()) return MAX_LIST_WIDTH;
    return clampLearnedSkillsListWidth(MAX_LIST_WIDTH, this.knownContainerWidth());
  }

  private knownContainerWidth(): number | undefined {
    try {
      const width = this.getBoundingClientRect().width;
      if (Number.isFinite(width) && width > 0) return width;
      const clientWidth = this.clientWidth;
      return clientWidth > 0 ? clientWidth : undefined;
    } catch {
      return undefined;
    }
  }

  private isNarrowViewport(): boolean {
    if (typeof window === "undefined") return false;
    try {
      return window.matchMedia("(max-width: 760px)").matches;
    } catch {
      return window.innerWidth <= 760;
    }
  }

  private finishPointerInteraction(persist: boolean): void {
    const interaction = this.pointerInteraction;
    if (interaction === undefined) return;
    this.pointerInteraction = undefined;
    interaction.divider.classList.remove("dragging");
    callPointerMethod(interaction.divider, "releasePointerCapture", interaction.pointerId);
    if (persist) writeLearnedSkillsListWidth(this.preferredListWidth);
  }
}

function renderPanelState(
  state: LearnedSkillsWorkspaceState,
  selectedSkillId: string | undefined,
  showMobileDetail: boolean,
): string {
  if (state.kind === "loading") return `<section class="state-screen" role="status">Loading learned skills...</section>`;
  if (state.kind === "unavailable") return `<section class="state-screen">Learned skills are unavailable.</section>`;
  if (state.kind === "error") {
    return `<section class="state-screen error" role="alert">
      <p>${escapeHtml(state.message)}</p>
      <button type="button" class="secondary" data-retry>Retry</button>
    </section>`;
  }

  const groups = [
    renderSkillGroup("project", "PROJECT", state.projectSkills, state.projectUnavailableMessage, selectedSkillId),
    renderSkillGroup("global", "GLOBAL", state.globalSkills, undefined, selectedSkillId),
  ].filter((group) => group !== "").join("");
  const empty = groups === "" ? `<p class="empty-list">No learned skills found.</p>` : "";
  const warning = state.refreshError === undefined
    ? ""
    : `<div class="refresh-warning" role="status">${escapeHtml(state.refreshError)}</div>`;
  const retry = state.refreshError === undefined ? "" : `<button type="button" class="secondary refresh-retry" data-retry>Retry</button>`;

  return `<section class="learned-skills-panel${showMobileDetail ? " show-mobile-detail" : ""}">
    <section class="skill-list" aria-label="Learned skills list">
      ${warning}
      ${groups}
      ${empty}
      ${retry}
    </section>
    <div
      class="skill-divider"
      role="separator"
      aria-label="Resize learned skills list"
      aria-orientation="vertical"
      aria-valuemin="${String(MIN_LIST_WIDTH)}"
      aria-valuemax="${String(MAX_LIST_WIDTH)}"
      aria-valuenow="280"
      tabindex="0"
    ></div>
    <section class="skill-detail" aria-label="Learned skill details">
      ${renderSkillDetail(state, selectedSkillId)}
    </section>
  </section>`;
}

function renderSkillGroup(
  scope: SkillScope,
  title: string,
  skills: LearnedSkill[],
  unavailableMessage: string | undefined,
  selectedSkillId: string | undefined,
): string {
  if (skills.length === 0 && unavailableMessage === undefined) return "";
  const warning = unavailableMessage === undefined
    ? ""
    : `<p class="group-warning" role="status">${escapeHtml(unavailableMessage)}</p>`;
  const rows = skills.map((skill) => renderSkillRow(scope, skill, selectedSkillId)).join("");
  return `<section class="skill-group" data-skill-group="${scope}">
    <header class="skill-group-header">
      <h2>${title}</h2>
      <span class="skill-count">${String(skills.length)}</span>
    </header>
    ${warning}
    ${rows}
  </section>`;
}

function renderSkillRow(scope: SkillScope, skill: LearnedSkill, selectedSkillId: string | undefined): string {
  const key = skillKey(scope, skill.id);
  const selected = key === selectedSkillId;
  return `<button type="button" class="skill-row${selected ? " selected" : ""}" data-skill-key="${escapeAttribute(key)}" aria-pressed="${String(selected)}">
    <span class="skill-row-name">${escapeHtml(skill.name)}</span>
    <span class="skill-row-description">${escapeHtml(skill.description)}</span>
  </button>`;
}

function renderSkillDetail(state: Extract<LearnedSkillsWorkspaceState, { kind: "data" }>, selectedSkillId: string | undefined): string {
  const selected = selectedSkillId === undefined ? undefined : findSelectedSkill(state, selectedSkillId);
  if (selected === undefined) return `<div class="detail-empty">Select a skill</div>`;

  const { scope, skill } = selected;
  const metadata = [
    `<div><dt>Path</dt><dd><code>${escapeHtml(skill.filePath)}</code></dd></div>`,
    ...(skill.version === undefined ? [] : [`<div><dt>Version</dt><dd>${escapeHtml(skill.version)}</dd></div>`]),
    ...(skill.created === undefined ? [] : [`<div><dt>Created</dt><dd>${escapeHtml(skill.created)}</dd></div>`]),
    ...(skill.updated === undefined ? [] : [`<div><dt>Updated</dt><dd>${escapeHtml(skill.updated)}</dd></div>`]),
  ].join("");
  return `<div class="detail-content">
    <button type="button" class="mobile-back" data-back aria-label="Back to learned skills" title="Back to learned skills">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m15 18-6-6 6-6"></path>
      </svg>
    </button>
    <div class="skill-scope">${scope.toUpperCase()}</div>
    <h2>${escapeHtml(skill.name)}</h2>
    <p class="skill-description">${escapeHtml(skill.description)}</p>
    <dl class="skill-metadata">${metadata}</dl>
  </div>`;
}

function findSelectedSkill(state: LearnedSkillsWorkspaceState, key: string): SelectedSkill | undefined {
  if (state.kind !== "data") return undefined;
  const project = state.projectSkills.find((skill) => skillKey("project", skill.id) === key);
  if (project !== undefined) return { scope: "project", skill: project };
  const global = state.globalSkills.find((skill) => skillKey("global", skill.id) === key);
  return global === undefined ? undefined : { scope: "global", skill: global };
}

function skillKey(scope: SkillScope, id: string): string {
  return `${scope}:${id}`;
}

function panelStyles(): string {
  return `<style>
    :host { display: block; height: 100%; min-height: 0; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    * { box-sizing: border-box; }
    .learned-skills-panel { display: grid; grid-template-columns: var(--learned-skills-list-width) 8px minmax(320px, 1fr); height: 100%; min-height: 0; overflow: hidden; }
    .skill-list, .skill-detail { min-width: 0; min-height: 0; overflow: auto; }
    .skill-list { padding: 2px 12px 12px 0; }
    .skill-detail { padding: 2px 0 12px 16px; border-left: 0; }
    .skill-group { margin-bottom: 16px; }
    .skill-group-header { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 4px 6px; border-bottom: 1px solid var(--pi-border); }
    .skill-group-header h2 { flex: 1 1 auto; min-width: 0; margin: 0; color: var(--pi-muted); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; }
    .skill-count { flex: 0 0 auto; color: var(--pi-muted); font-size: 12px; }
    .skill-row { display: block; width: 100%; min-width: 0; margin: 4px 0 0; padding: 9px 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--pi-text); cursor: pointer; text-align: left; font: inherit; }
    .skill-row:hover { background: var(--pi-surface-hover); }
    .skill-row:focus-visible, .mobile-back:focus-visible, .skill-divider:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .skill-row.selected { border-color: var(--pi-accent-border); background: var(--pi-selection-bg); }
    .skill-row-name { display: block; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .skill-row-description { display: block; margin-top: 3px; overflow: hidden; color: var(--pi-muted); font-size: 12px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
    .skill-divider { position: relative; min-width: 8px; border: 0; background: transparent; cursor: col-resize; touch-action: none; }
    .skill-divider::before { position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: var(--pi-border); content: ""; }
    .skill-divider:hover::before, .skill-divider:focus-visible::before, .skill-divider.dragging::before { background: var(--pi-accent); }
    .detail-content { max-width: 760px; padding: 2px 12px 12px 0; }
    .detail-content h2 { margin: 0 0 12px; overflow-wrap: anywhere; font-size: 22px; line-height: 1.25; }
    .skill-scope { margin-bottom: 6px; color: var(--pi-accent); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; }
    .skill-description { margin: 0 0 20px; max-width: 70ch; line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
    .skill-metadata { display: grid; gap: 8px; margin: 0; color: var(--pi-muted); }
    .skill-metadata > div { display: grid; grid-template-columns: minmax(70px, auto) minmax(0, 1fr); gap: 12px; }
    .skill-metadata dt { font-weight: 600; }
    .skill-metadata dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    .skill-metadata code { color: var(--pi-text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .detail-empty, .empty-list, .state-screen { color: var(--pi-muted); }
    .detail-empty { display: grid; min-height: 180px; place-items: center; padding: 24px; text-align: center; }
    .empty-list { padding: 20px 4px; }
    .state-screen { display: grid; min-height: 160px; place-items: center; gap: 12px; padding: 24px; text-align: center; }
    .state-screen.error { color: var(--pi-danger); }
    .state-screen p { margin: 0; overflow-wrap: anywhere; }
    .refresh-warning, .group-warning { color: var(--pi-warning, #b45309); line-height: 1.4; overflow-wrap: anywhere; }
    .refresh-warning { margin: 0 0 8px; padding: 8px 10px; border-left: 2px solid var(--pi-warning, #b45309); }
    .group-warning { margin: 8px 4px; }
    button.secondary { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); cursor: pointer; padding: 7px 10px; font: inherit; }
    button.secondary:hover { background: var(--pi-surface-hover); }
    .refresh-retry { margin: 0 0 12px 4px; }
    .mobile-back { display: none; width: 32px; height: 32px; margin: 0 0 12px; padding: 5px; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); cursor: pointer; }
    .mobile-back svg { display: block; width: 20px; height: 20px; }

    @media (max-width: 760px) {
      .learned-skills-panel { display: block; }
      .skill-list, .skill-detail { height: 100%; padding: 0; }
      .skill-detail { display: none; }
      .learned-skills-panel.show-mobile-detail .skill-list { display: none; }
      .learned-skills-panel.show-mobile-detail .skill-detail { display: block; }
      .skill-divider { display: none; }
      .mobile-back { display: block; }
    }
  </style>`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function callPointerMethod(element: HTMLElement, methodName: string, pointerId: number): void {
  const method: unknown = Reflect.get(element, methodName);
  if (typeof method === "function") method.call(element, pointerId);
}
