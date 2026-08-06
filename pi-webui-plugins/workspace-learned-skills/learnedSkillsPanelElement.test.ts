// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRailContext } from "@hyperdreamer/pi-webui/plugin-api";
import type { LearnedSkill, LearnedSkillsWorkspaceState } from "./learnedSkillsData.js";
import {
  defineLearnedSkillsPanelElement,
  isLearnedSkillsPanelVisible,
  learnedSkillsBadge,
  learnedSkillsPanelTagName,
} from "./learnedSkillsPanelElement.js";
import {
  LEARNED_SKILLS_LAYOUT_STORAGE_KEY,
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
} from "./learnedSkillsPanelLayout.js";

interface LearnedSkillsPanelTestElement extends HTMLElement {
  context: ActivityRailContext | undefined;
  learnedSkillsState: LearnedSkillsWorkspaceState;
  onRetry: (() => void) | undefined;
}

const globalSkill = skill("global", "Global skill", "/global/SKILL.md", {
  description: "Global description",
  version: 2,
  created: "2026-01-02",
  updated: "2026-03-04",
});
const projectSkill = skill("project", "Project skill", "/project/SKILL.md", {
  description: "Project description",
});

describe("learned skills panel element", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    defineLearnedSkillsPanelElement();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defines the custom element only once", () => {
    const constructor = customElements.get(learnedSkillsPanelTagName);

    defineLearnedSkillsPanelElement();

    expect(customElements.get(learnedSkillsPanelTagName)).toBe(constructor);
  });

  it("renders loading and first-load error states with Retry", () => {
    const panel = createPanel();
    expect(shadow(panel).textContent).toContain("Loading learned skills");

    const retry = vi.fn();
    panel.onRetry = retry;
    panel.learnedSkillsState = { kind: "error", message: "Provider offline" };

    expect(shadow(panel).textContent).toContain("Provider offline");
    requireElement(shadow(panel), "button[data-retry]").click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("renders the successful empty state without empty scope groups", () => {
    const panel = createPanel();

    panel.learnedSkillsState = dataState();

    expect(shadow(panel).textContent).toContain("No learned skills found");
    expect(shadow(panel).querySelector('[data-skill-group="project"]')).toBeNull();
    expect(shadow(panel).querySelector('[data-skill-group="global"]')).toBeNull();
  });

  it("retains data under a refresh warning and retries on request", () => {
    const panel = createPanel();
    const retry = vi.fn();
    panel.onRetry = retry;
    panel.learnedSkillsState = dataState({
      globalSkills: [globalSkill],
      refreshError: "Refresh failed; showing the previous snapshot.",
    });

    expect(shadow(panel).textContent).toContain("Global skill");
    expect(shadow(panel).textContent).toContain("Refresh failed; showing the previous snapshot.");
    requireElement(shadow(panel), "button[data-retry]").click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps PROJECT visible for a scoped warning while omitting a successfully empty GLOBAL group", () => {
    const panel = createPanel();

    panel.learnedSkillsState = dataState({
      projectUnavailableMessage: "Project skills could not be read.",
    });

    const project = requireElement(shadow(panel), '[data-skill-group="project"]');
    expect(project.textContent).toContain("PROJECT");
    expect(project.textContent).toContain("Project skills could not be read.");
    expect(shadow(panel).querySelector('[data-skill-group="global"]')).toBeNull();
  });

  it("renders populated PROJECT then GLOBAL groups", () => {
    const panel = createPanel();

    panel.learnedSkillsState = dataState({
      globalSkills: [globalSkill],
      projectSkills: [projectSkill],
    });

    const groups = [...shadow(panel).querySelectorAll("[data-skill-group]")];
    expect(groups.map((group) => group.getAttribute("data-skill-group"))).toEqual(["project", "global"]);
    expect(groups[0]?.textContent).toContain("Project skill");
    expect(groups[1]?.textContent).toContain("Global skill");
  });

  it("keeps generated skill names on one ellipsized line", () => {
    const panel = createPanel();
    const longName = "generated-learned-skill-name-".repeat(16);
    panel.learnedSkillsState = dataState({
      globalSkills: [skill("long", longName, "/global/long/SKILL.md")],
    });

    const name = requireElement(shadow(panel), ".skill-row-name");
    expect(name.textContent).toBe(longName);

    const panelStyle = shadow(panel).querySelector("style")?.textContent;
    if (panelStyle === undefined) throw new Error("Expected panel styles");
    const parsedStyle = document.createElement("style");
    parsedStyle.textContent = panelStyle;
    document.body.append(parsedStyle);
    const nameRule = [...(parsedStyle.sheet?.cssRules ?? [])]
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .find((rule) => rule.selectorText === ".skill-row-name");

    expect(nameRule?.style.overflow).toBe("hidden");
    expect(nameRule?.style.textOverflow).toBe("ellipsis");
    expect(nameRule?.style.whiteSpace).toBe("nowrap");
  });

  it("starts with a Select a skill detail state", () => {
    const panel = createPanel();
    panel.learnedSkillsState = dataState({ globalSkills: [globalSkill] });

    expect(requireElement(shadow(panel), ".skill-detail").textContent).toContain("Select a skill");
  });

  it("selects rows by namespaced id and escapes all detail content", () => {
    const panel = createPanel();
    const malicious = skill("same", '<Name & "quoted">', '</code><script>bad()</script>', {
      description: '<img src=x onerror="bad()">',
      version: 7,
      created: "<created>",
      updated: "<updated>",
    });
    panel.learnedSkillsState = dataState({
      globalSkills: [skill("same", "Wrong scope", "/global/wrong")],
      projectSkills: [malicious],
    });

    requireElement(shadow(panel), 'button[data-skill-key="project:same"]').click();

    const detail = requireElement(shadow(panel), ".skill-detail");
    expect(detail.textContent).toContain("PROJECT");
    expect(detail.textContent).toContain('<Name & "quoted">');
    expect(detail.textContent).toContain('<img src=x onerror="bad()">');
    expect(detail.textContent).toContain('</code><script>bad()</script>');
    expect(detail.textContent).toContain("Version");
    expect(detail.textContent).toContain("7");
    expect(detail.textContent).toContain("<created>");
    expect(detail.textContent).toContain("<updated>");
    expect(detail.querySelector("script")).toBeNull();
    expect(detail.querySelector("img")).toBeNull();
    expect(detail.textContent).not.toContain("Wrong scope");
  });

  it("exposes an accessible desktop separator", () => {
    const panel = createPanel();
    panel.learnedSkillsState = dataState({ globalSkills: [globalSkill] });

    const separator = requireElement(shadow(panel), '[role="separator"]');
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-valuemin")).toBe(String(MIN_LIST_WIDTH));
    expect(separator.getAttribute("aria-valuemax")).toBe(String(MAX_LIST_WIDTH));
    expect(separator.getAttribute("aria-valuenow")).toBe("280");
  });

  it("reclamps a persisted width when the host becomes measurable after connection", () => {
    const resizeObserver = installResizeObserverHarness();
    window.localStorage.setItem(
      LEARNED_SKILLS_LAYOUT_STORAGE_KEY,
      JSON.stringify({ version: 1, listWidth: 440 }),
    );
    let containerWidth = 0;
    const element = document.createElement(learnedSkillsPanelTagName);
    // The tag is defined above, so this assertion narrows its public property contract.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const panel = element as LearnedSkillsPanelTestElement;
    vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, containerWidth, 640),
    );
    panel.learnedSkillsState = dataState({ globalSkills: [globalSkill] });
    document.body.append(panel);

    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("440px");

    containerWidth = 700;
    resizeObserver.notify();

    const separator = requireElement(shadow(panel), '[role="separator"]');
    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("372px");
    expect(separator.getAttribute("aria-valuemax")).toBe("372");
    expect(separator.getAttribute("aria-valuenow")).toBe("372");
    expect(JSON.parse(requireStoredLayout())).toEqual({ version: 1, listWidth: 440 });

    panel.remove();
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce();
  });

  it("pointer drag captures input, clamps both ends, updates width, and persists on pointerup", () => {
    const panel = createPanel(900);
    panel.learnedSkillsState = dataState({ globalSkills: [globalSkill] });
    const separator = requireElement(shadow(panel), '[role="separator"]');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });

    separator.dispatchEvent(pointerEvent("pointerdown", 4, 280, 0));
    window.dispatchEvent(pointerEvent("pointermove", 4, 900));
    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("440px");
    window.dispatchEvent(pointerEvent("pointermove", 4, -900));
    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("190px");
    expect(window.localStorage.getItem(LEARNED_SKILLS_LAYOUT_STORAGE_KEY)).toBeNull();

    window.dispatchEvent(pointerEvent("pointerup", 4, -900));

    expect(setPointerCapture).toHaveBeenCalledWith(4);
    expect(releasePointerCapture).toHaveBeenCalledWith(4);
    expect(JSON.parse(requireStoredLayout())).toEqual({ version: 1, listWidth: 190 });
  });

  it("resizes and persists with Arrow keys, Home, and runtime-clamped End", () => {
    const panel = createPanel(700);
    panel.learnedSkillsState = dataState({ globalSkills: [globalSkill] });
    const separator = requireElement(shadow(panel), '[role="separator"]');

    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("256px");
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("328px");
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("190px");
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("372px");
    expect(JSON.parse(requireStoredLayout())).toEqual({ version: 1, listWidth: 372 });
  });

  it("ignores unhandled separator keys", () => {
    const panel = createPanel();
    panel.learnedSkillsState = dataState({ globalSkills: [globalSkill] });
    const separator = requireElement(shadow(panel), '[role="separator"]');
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });

    separator.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("280px");
    expect(window.localStorage.getItem(LEARNED_SKILLS_LAYOUT_STORAGE_KEY)).toBeNull();
  });

  it("returns to empty detail when the selected skill disappears", () => {
    const panel = createPanel();
    panel.learnedSkillsState = dataState({ globalSkills: [globalSkill] });
    requireElement(shadow(panel), 'button[data-skill-key="global:global"]').click();
    expect(requireElement(shadow(panel), ".skill-detail").textContent).toContain("Global skill");

    panel.learnedSkillsState = dataState({ globalSkills: [skill("replacement", "Replacement", "/replacement")] });

    expect(requireElement(shadow(panel), ".skill-detail").textContent).toContain("Select a skill");
  });

  it("uses narrow detail navigation and the icon-only Back button returns to the list", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
    const panel = createPanel(600);
    panel.learnedSkillsState = dataState({ projectSkills: [projectSkill] });

    requireElement(shadow(panel), 'button[data-skill-key="project:project"]').click();

    expect(requireElement(shadow(panel), ".learned-skills-panel").classList).toContain("show-mobile-detail");
    const back = requireElement(shadow(panel), "button[data-back]");
    expect(back.getAttribute("aria-label")).toBe("Back to learned skills");
    expect(back.getAttribute("title")).toBe("Back to learned skills");
    expect(back.querySelector("svg")).not.toBeNull();

    back.click();

    expect(requireElement(shadow(panel), ".learned-skills-panel").classList).not.toContain("show-mobile-detail");
  });

  it("disconnect removes window listeners and cancels an active drag without persistence", () => {
    const removeListener = vi.spyOn(window, "removeEventListener");
    const panel = createPanel();
    panel.learnedSkillsState = dataState({ globalSkills: [globalSkill] });
    const separator = requireElement(shadow(panel), '[role="separator"]');
    const releasePointerCapture = vi.fn();
    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });
    separator.dispatchEvent(pointerEvent("pointerdown", 9, 280, 0));

    panel.remove();
    window.dispatchEvent(pointerEvent("pointermove", 9, 800));
    window.dispatchEvent(pointerEvent("pointerup", 9, 800));

    expect(removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("pointercancel", expect.any(Function));
    expect(releasePointerCapture).toHaveBeenCalledWith(9);
    expect(panel.style.getPropertyValue("--learned-skills-list-width")).toBe("280px");
    expect(window.localStorage.getItem(LEARNED_SKILLS_LAYOUT_STORAGE_KEY)).toBeNull();
  });
});

describe("learned skills contribution helpers", () => {
  it("returns no badge for non-data or empty states and totals populated data", () => {
    expect(learnedSkillsBadge({ kind: "loading" })).toBeUndefined();
    expect(learnedSkillsBadge({ kind: "unavailable" })).toBeUndefined();
    expect(learnedSkillsBadge({ kind: "error", message: "offline" })).toBeUndefined();
    expect(learnedSkillsBadge(dataState())).toBeUndefined();
    expect(learnedSkillsBadge(dataState({ globalSkills: [globalSkill], projectSkills: [projectSkill] }))).toBe(2);
  });

  it("hides only confirmed unavailability", () => {
    expect(isLearnedSkillsPanelVisible({ kind: "unavailable" })).toBe(false);
    expect(isLearnedSkillsPanelVisible({ kind: "loading" })).toBe(true);
    expect(isLearnedSkillsPanelVisible({ kind: "error", message: "offline" })).toBe(true);
    expect(isLearnedSkillsPanelVisible(dataState())).toBe(true);
  });
});

function createPanel(width = 900): LearnedSkillsPanelTestElement {
  const element = document.createElement(learnedSkillsPanelTagName);
  // The tag is defined above, so this assertion narrows its public property contract.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const panel = element as LearnedSkillsPanelTestElement;
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, 640));
  document.body.append(panel);
  return panel;
}

function shadow(panel: LearnedSkillsPanelTestElement): ShadowRoot {
  if (panel.shadowRoot === null) throw new Error("Expected an open shadow root");
  return panel.shadowRoot;
}

function requireElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Expected element matching ${selector}`);
  return element;
}

function skill(
  id: string,
  name: string,
  filePath: string,
  fields: Partial<Omit<LearnedSkill, "id" | "name" | "filePath">> = {},
): LearnedSkill {
  return {
    id,
    name,
    description: fields.description ?? `${name} description`,
    filePath,
    ...(fields.version === undefined ? {} : { version: fields.version }),
    ...(fields.created === undefined ? {} : { created: fields.created }),
    ...(fields.updated === undefined ? {} : { updated: fields.updated }),
  };
}

function dataState(fields: Partial<Extract<LearnedSkillsWorkspaceState, { kind: "data" }>> = {}): Extract<LearnedSkillsWorkspaceState, { kind: "data" }> {
  return {
    kind: "data",
    globalSkills: fields.globalSkills ?? [],
    projectSkills: fields.projectSkills ?? [],
    ...(fields.projectUnavailableMessage === undefined ? {} : { projectUnavailableMessage: fields.projectUnavailableMessage }),
    ...(fields.refreshError === undefined ? {} : { refreshError: fields.refreshError }),
  };
}

function pointerEvent(type: string, pointerId: number, clientX: number, button?: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    button: { value: button ?? 0 },
  });
  return event;
}

function installResizeObserverHarness(): {
  notify: () => void;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const observers: TestResizeObserver[] = [];
  const disconnect = vi.fn();

  class TestResizeObserver {
    private observing = false;

    public constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }

    public observe(): void {
      this.observing = true;
    }

    public unobserve(): void {
      this.observing = false;
    }

    public disconnect(): void {
      this.observing = false;
      disconnect();
    }

    public notify(): void {
      if (!this.observing) return;
      // No entry data is needed: the panel deliberately measures its own host.
      this.callback([], this);
    }
  }

  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  return {
    notify: () => { for (const observer of observers) observer.notify(); },
    disconnect,
  };
}

function requireStoredLayout(): string {
  const value = window.localStorage.getItem(LEARNED_SKILLS_LAYOUT_STORAGE_KEY);
  if (value === null) throw new Error("Expected a persisted learned-skills layout");
  return value;
}
