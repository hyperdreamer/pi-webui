// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Machine, MachineHealth, MachineStatus, WorkspaceActivity } from "../api";
import { MachineSwitcher } from "./MachineSwitcher";

const REMOTE_NAME = "Long remote workstation name";
const REMOTE_BASE_URL = "https://remote.example.test";

beforeEach(() => {
  // jsdom has no layout and no scrollIntoView implementation.
  if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  }
});

afterEach(() => {
  // Replacing the body disconnects the mount, which also removes the switcher's
  // document click listener.
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function machine(id: string, name: string): Machine {
  const common = { id, name, createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z" };
  return id === "local"
    ? { ...common, kind: "local" }
    : { ...common, kind: "remote", baseUrl: REMOTE_BASE_URL };
}

function health(status: MachineStatus): MachineHealth {
  return { machineId: "remote", ok: status === "online", checkedAt: "2026-10-17T00:00:00.000Z", status };
}

async function mountSwitcher(status: MachineStatus): Promise<MachineSwitcher> {
  const local = machine("local", "Local");
  const remote = { ...machine("remote", REMOTE_NAME), status };
  const element = new MachineSwitcher();
  element.machines = [local, remote];
  element.selected = remote;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function root(element: MachineSwitcher): ShadowRoot {
  const shadowRoot = element.shadowRoot;
  if (shadowRoot === null) throw new Error("Expected an open shadow root");
  return shadowRoot;
}

function selectedButton(element: MachineSwitcher): HTMLButtonElement {
  const button = root(element).querySelector<HTMLButtonElement>(".machine-switcher-button");
  if (button === null) throw new Error("Expected the selected machine button");
  return button;
}

function shadowElement(element: MachineSwitcher, selector: string): HTMLElement {
  const found = root(element).querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`Expected ${selector} inside the switcher shadow root`);
  return found;
}

function shadowElements(element: MachineSwitcher, selector: string): HTMLElement[] {
  return Array.from(root(element).querySelectorAll<HTMLElement>(selector));
}

function dispatchKeydown(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  return event;
}

function componentStyleRule(selector: string): CSSStyleDeclaration {
  const element = document.createElement("style");
  element.textContent = MachineSwitcher.styles.cssText;
  document.head.append(element);
  try {
    const rule = Array.from(element.sheet?.cssRules ?? []).find(
      (candidate): candidate is CSSStyleRule => candidate instanceof CSSStyleRule && candidate.selectorText === selector,
    );
    if (rule === undefined) throw new Error(`Missing stylesheet rule: ${selector}`);
    return rule.style;
  } finally {
    element.remove();
  }
}

function styleRuleText(declaration: CSSStyleDeclaration): string {
  const parts: string[] = [];
  for (let index = 0; index < declaration.length; index += 1) {
    const name = declaration.item(index);
    parts.push(`${name}:${declaration.getPropertyValue(name)}`);
  }
  return parts.join(";").toLowerCase();
}

function normalized(declaration: CSSStyleDeclaration, property: string, fallback?: string): string {
  const value = declaration.getPropertyValue(property).trim().toLowerCase();
  return value === "" ? (fallback ?? value) : value;
}

function clipValueIsEmptyRect(declaration: CSSStyleDeclaration): boolean {
  // CSSOM may collapse `rect(0 0 0 0)` to `rect(0px)` because every inset is equal.
  const value = declaration.getPropertyValue("clip").trim().toLowerCase();
  const match = /^rect\((.+)\)$/.exec(value);
  if (match === null) return false;
  const insets = (match[1] ?? "").split(/[\s,]+/).filter((part) => part !== "");
  return insets.length >= 1 && insets.length <= 4 && insets.every((part) => part === "0" || part === "0px");
}

async function openMenu(element: MachineSwitcher): Promise<void> {
  selectedButton(element).click();
  await element.updateComplete;
}

describe("machine-switcher selected button accessibility", () => {
  for (const status of ["online", "offline", "error", "unknown"] as const) {
    it(`describes the selected button for the ${status} status`, async () => {
      const element = await mountSwitcher(status);
      const button = selectedButton(element);
      const statusElement = shadowElement(element, ".machine-switcher-button > .machine-status");

      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("aria-label")).toBe(`Machine: ${REMOTE_NAME}. Switch machine.`);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("title")).toBe(`${REMOTE_NAME} — ${REMOTE_BASE_URL}`);
      expect(button.getAttribute("title")).toContain(REMOTE_NAME);
      expect(button.getAttribute("title")).toContain(REMOTE_BASE_URL);
      expect(statusElement.getAttribute("title")).toBe(status);
      expect(button.getAttribute("aria-describedby")).toBe("machine-status-description");

      const description = root(element).getElementById("machine-status-description");
      expect(description).not.toBeNull();
      expect(description?.textContent).toBe(`Machine status: ${status}.`);
      expect(shadowElements(element, "#machine-status-description")).toHaveLength(1);
    });
  }

  it("keeps the description correct when authoritative health replaces the machine status", async () => {
    const element = await mountSwitcher("online");
    const button = selectedButton(element);

    element.statuses = { remote: health("offline") };
    await element.updateComplete;

    expect(shadowElement(element, ".machine-switcher-button > .machine-status").getAttribute("title")).toBe("offline");
    expect(root(element).getElementById("machine-status-description")?.textContent).toBe("Machine status: offline.");
    expect(button.getAttribute("aria-describedby")).toBe("machine-status-description");
  });

  it("keeps the same DOM contract at narrow and wide host widths", async () => {
    // Width-independent DOM test: jsdom performs no container queries, so these
    // assignments only prove the markup does not depend on a measured width.
    // Task 4 proves the actual word/dot states in Chromium.
    for (const width of ["104px", "194px"]) {
      const element = await mountSwitcher("online");
      element.style.width = width;
      await element.updateComplete;

      const button = selectedButton(element);
      expect(button.getAttribute("aria-label")).toBe(`Machine: ${REMOTE_NAME}. Switch machine.`);
      expect(button.getAttribute("title")).toBe(`${REMOTE_NAME} — ${REMOTE_BASE_URL}`);
      expect(root(element).getElementById("machine-status-description")?.textContent).toBe("Machine status: online.");
      expect(shadowElement(element, ".machine-switcher-button > .machine-status").getAttribute("title")).toBe("online");
      expect(shadowElement(element, ".machine-switcher-kicker").textContent).toBe("Machine");
      document.body.replaceChildren();
    }
  });

  it("uses the machine name alone as the identity tooltip when there is no base URL", async () => {
    const local = machine("local", "Local");
    const element = new MachineSwitcher();
    element.machines = [local, machine("remote", REMOTE_NAME)];
    element.selected = local;
    document.body.append(element);
    await element.updateComplete;

    expect(selectedButton(element).getAttribute("title")).toBe("Local");
    expect(selectedButton(element).getAttribute("aria-label")).toBe("Machine: Local. Switch machine.");
  });

  it("keeps the full health word in every menu entry", async () => {
    const element = await mountSwitcher("online");
    element.statuses = { local: health("offline"), remote: health("error") };
    await element.updateComplete;
    await openMenu(element);

    expect(shadowElements(element, ".machine-option small").map((entry) => entry.textContent)).toEqual([
      "Local Pi WebUI · offline",
      `${REMOTE_BASE_URL} · error`,
    ]);
    expect(shadowElement(element, ".machine-switcher-kicker").textContent).toBe("Machine");
  });

  it("renders the two named CSS containers and the local layout declarations", () => {
    const hostStyle = componentStyleRule(":host");
    expect(hostStyle.getPropertyValue("container-type")).toBe("inline-size");
    expect(hostStyle.getPropertyValue("container-name")).toBe("machine-switcher");
    expect(hostStyle.getPropertyValue("min-width")).toBe("0");
    expect(hostStyle.getPropertyValue("display")).toBe("block");

    const textStyle = componentStyleRule(".machine-switcher-text");
    expect(textStyle.getPropertyValue("min-width")).toBe("48px");
    expect(textStyle.getPropertyValue("display")).toBe("grid");

    expect(componentStyleRule(".machine-switcher-kicker").getPropertyValue("white-space")).toBe("nowrap");

    const labelStyle = componentStyleRule(".machine-switcher-label");
    expect(labelStyle.getPropertyValue("min-width")).toBe("0");
    expect(labelStyle.getPropertyValue("overflow")).toBe("hidden");
    expect(labelStyle.getPropertyValue("text-overflow")).toBe("ellipsis");
    expect(labelStyle.getPropertyValue("white-space")).toBe("nowrap");

    const cssText = MachineSwitcher.styles.cssText;
    expect(cssText).toMatch(/@container\s+machine-switcher\s*\(width\s*<\s*150px\)\s*\{\s*\.machine-switcher-button\s*>\s*\.machine-status\s*\{/);
    expect(cssText).toMatch(/\.machine-switcher-button\s*\{[^}]*padding:\s*5px 8px;/);
    expect(cssText).toMatch(/\.machine-switcher-button\s*\{[^}]*gap:\s*6px;/);
    expect(cssText).toMatch(/\.machine-switcher-button\s*\{[^}]*border:\s*1px solid/);
  });

  it("hides the status description visually without removing it from the accessibility tree", () => {
    const style = componentStyleRule("#machine-status-description");

    expect(normalized(style, "position")).toBe("absolute");
    expect(normalized(style, "width")).toBe("1px");
    expect(normalized(style, "height")).toBe("1px");
    expect(normalized(style, "padding", "0px")).toBe("0px");
    expect(normalized(style, "margin")).toBe("-1px");
    expect(normalized(style, "overflow")).toBe("hidden");
    expect(clipValueIsEmptyRect(style)).toBe(true);
    expect(normalized(style, "clip-path").replace(/\s+/g, "")).toBe("inset(50%)");
    expect(normalized(style, "white-space")).toBe("nowrap");
    expect(normalized(style, "border", "0px")).toBe("0px");
    expect(normalized(style, "display")).not.toBe("none");
    expect(normalized(style, "visibility")).not.toBe("hidden");
    expect(normalized(style, "visibility")).toBe("");
    expect(styleRuleText(style)).not.toContain("display:none");
    expect(styleRuleText(style)).not.toContain("visibility:hidden");
  });

  it("keeps every description id resolvable inside its own shadow root", async () => {
    const first = await mountSwitcher("online");
    const second = await mountSwitcher("error");

    for (const element of [first, second]) {
      const shadowRoot = root(element);
      const descriptions = shadowRoot.querySelectorAll("#machine-status-description");
      expect(descriptions).toHaveLength(1);
      expect(shadowRoot.getElementById("machine-status-description")).toBe(descriptions[0]);
      expect(selectedButton(element).getAttribute("aria-describedby")).toBe("machine-status-description");
    }
    expect(root(first).getElementById("machine-status-description")?.textContent).toBe("Machine status: online.");
    expect(root(second).getElementById("machine-status-description")?.textContent).toBe("Machine status: error.");
  });

  it("renders no selected button with zero machines and renders safely with one", async () => {
    const empty = new MachineSwitcher();
    document.body.append(empty);
    await empty.updateComplete;
    expect(shadowElements(empty, ".machine-switcher-button")).toHaveLength(0);

    const single = new MachineSwitcher();
    single.machines = [machine("local", "Local")];
    single.selected = machine("local", "Local");
    document.body.append(single);
    await single.updateComplete;

    expect(shadowElements(single, ".machine-switcher-button")).toHaveLength(1);
    expect(selectedButton(single).getAttribute("aria-label")).toBe("Machine: Local. Switch machine.");
    expect(root(single).getElementById("machine-status-description")?.textContent).toBe("Machine status: unknown.");
  });
});

describe("machine-switcher interaction", () => {
  it("opens the menu from an explicit click and lists every machine in input order", async () => {
    const element = await mountSwitcher("online");
    await openMenu(element);

    expect(selectedButton(element).getAttribute("aria-expanded")).toBe("true");
    expect(shadowElements(element, ".machine-option-main").map((option) => option.getAttribute("data-machine-id"))).toEqual(["local", "remote"]);
  });

  it("opens on the selected option and moves between options with ArrowDown and ArrowUp", async () => {
    const first = machine("local", "Local");
    const second = machine("remote", REMOTE_NAME);
    const third = machine("third", "Third machine");
    const element = new MachineSwitcher();
    element.machines = [first, second, third];
    element.selected = first;
    document.body.append(element);
    await element.updateComplete;

    const trigger = selectedButton(element);
    dispatchKeydown(trigger, "ArrowDown");
    await element.updateComplete;
    const options = shadowElements(element, ".machine-option-main");
    expect(options).toHaveLength(3);
    expect(root(element).activeElement).toBe(options[0]);

    dispatchKeydown(options[0] ?? trigger, "ArrowDown");
    expect(root(element).activeElement).toBe(options[1]);
    dispatchKeydown(options[1] ?? trigger, "ArrowDown");
    expect(root(element).activeElement).toBe(options[2]);
    dispatchKeydown(options[2] ?? trigger, "ArrowDown");
    expect(root(element).activeElement).toBe(options[2]);

    dispatchKeydown(options[2] ?? trigger, "ArrowUp");
    expect(root(element).activeElement).toBe(options[1]);
    dispatchKeydown(options[1] ?? trigger, "ArrowUp");
    expect(root(element).activeElement).toBe(options[0]);
    dispatchKeydown(options[0] ?? trigger, "ArrowUp");
    expect(root(element).activeElement).toBe(options[0]);
  });

  it("keeps Home and End navigation on options", async () => {
    const element = await mountSwitcher("online");
    await openMenu(element);
    const options = shadowElements(element, ".machine-option-main");
    const last = options[1];

    dispatchKeydown(options[0] ?? last ?? element, "End");
    expect(root(element).activeElement).toBe(last);
    dispatchKeydown(last ?? element, "Home");
    expect(root(element).activeElement).toBe(options[0]);
  });

  it("closes the menu with Escape or ArrowLeft from an option and restores trigger focus", async () => {
    for (const key of ["Escape", "ArrowLeft"]) {
      const onCancelKeyboardNavigation = vi.fn();
      const onFocusNextSection = vi.fn();
      const element = await mountSwitcher("online");
      element.onCancelKeyboardNavigation = onCancelKeyboardNavigation;
      element.onFocusNextSection = onFocusNextSection;
      await element.updateComplete;
      await openMenu(element);
      const option = shadowElements(element, ".machine-option-main")[0];
      if (option === undefined) throw new Error("Expected an option");
      dispatchKeydown(option, key);
      await element.updateComplete;

      expect(root(element).activeElement).toBe(selectedButton(element));
      expect(selectedButton(element).getAttribute("aria-expanded")).toBe("false");
      expect(onCancelKeyboardNavigation).not.toHaveBeenCalled();
      expect(onFocusNextSection).not.toHaveBeenCalled();
      document.body.replaceChildren();
    }
  });

  it("closes an open menu with Escape or ArrowLeft on the trigger without cancelling navigation", async () => {
    for (const key of ["Escape", "ArrowLeft"]) {
      const onCancelKeyboardNavigation = vi.fn();
      const element = await mountSwitcher("online");
      element.onCancelKeyboardNavigation = onCancelKeyboardNavigation;
      await element.updateComplete;
      await openMenu(element);
      const trigger = selectedButton(element);
      trigger.focus();

      const event = dispatchKeydown(trigger, key);
      await element.updateComplete;

      expect(event.defaultPrevented).toBe(true);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(root(element).activeElement).toBe(trigger);
      expect(onCancelKeyboardNavigation).not.toHaveBeenCalled();
      document.body.replaceChildren();
    }
  });

  it("cancels navigation when Escape arrives on a closed trigger", async () => {
    const onCancelKeyboardNavigation = vi.fn();
    const element = await mountSwitcher("online");
    element.onCancelKeyboardNavigation = onCancelKeyboardNavigation;
    await element.updateComplete;
    const trigger = selectedButton(element);
    trigger.focus();

    const event = dispatchKeydown(trigger, "Escape");

    expect(event.defaultPrevented).toBe(true);
    expect(onCancelKeyboardNavigation).toHaveBeenCalledOnce();
  });

  it("forwards ArrowRight from an open trigger once and closes the menu", async () => {
    const onFocusNextSection = vi.fn();
    const onCancelKeyboardNavigation = vi.fn();
    const element = await mountSwitcher("online");
    element.onFocusNextSection = onFocusNextSection;
    element.onCancelKeyboardNavigation = onCancelKeyboardNavigation;
    await element.updateComplete;
    await openMenu(element);
    const trigger = selectedButton(element);

    dispatchKeydown(trigger, "ArrowRight");
    await element.updateComplete;

    expect(onFocusNextSection).toHaveBeenCalledOnce();
    expect(onCancelKeyboardNavigation).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("forwards ArrowRight from an option once and closes the menu", async () => {
    const onFocusNextSection = vi.fn();
    const element = await mountSwitcher("online");
    element.onFocusNextSection = onFocusNextSection;
    await element.updateComplete;
    await openMenu(element);
    const option = shadowElements(element, ".machine-option-main")[1];
    if (option === undefined) throw new Error("Expected an option");

    dispatchKeydown(option, "ArrowRight");
    await element.updateComplete;

    expect(onFocusNextSection).toHaveBeenCalledOnce();
    expect(selectedButton(element).getAttribute("aria-expanded")).toBe("false");
  });

  it("selects a machine once from its option", async () => {
    const onSelect = vi.fn();
    const element = await mountSwitcher("online");
    element.onSelect = onSelect;
    await element.updateComplete;
    await openMenu(element);
    const option = shadowElements(element, ".machine-option-main")[0];
    if (option === undefined) throw new Error("Expected an option");

    option.click();

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(machine("local", "Local"));
  });

  it("removes a remote machine once through its actions menu", async () => {
    const onRemove = vi.fn();
    const element = await mountSwitcher("online");
    element.onRemove = onRemove;
    await element.updateComplete;
    await openMenu(element);

    const actionsToggle = shadowElement(element, '.machine-option-actions-toggle[aria-label="Actions for Long remote workstation name"]');
    actionsToggle.click();
    await element.updateComplete;
    const remove = shadowElement(element, '.machine-option-actions-panel button.danger');
    remove.click();

    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith({ ...machine("remote", REMOTE_NAME), status: "online" });
  });

  it("keeps removal availability governed by the machine kind", async () => {
    const element = await mountSwitcher("online");
    element.onRemove = vi.fn();
    await element.updateComplete;
    await openMenu(element);

    expect(shadowElements(element, ".machine-option-actions-toggle")).toHaveLength(1);
    expect(shadowElement(element, ".machine-option-actions-toggle").getAttribute("aria-label")).toBe(`Actions for ${REMOTE_NAME}`);
  });

  it("edits from the switcher actions menu through the shared callback", async () => {
    const edit = vi.fn();
    const select = vi.fn();
    const element = await mountSwitcher("online");
    element.onEdit = edit;
    element.onSelect = select;
    await element.updateComplete;
    await openMenu(element);

    const actionsToggle = shadowElement(element, `.machine-option-actions-toggle[aria-label="Actions for ${REMOTE_NAME}"]`);
    actionsToggle.click();
    await element.updateComplete;
    const editButton = shadowElements(element, ".machine-option-actions-panel button")
      .find((button) => button.textContent.trim() === "Edit");
    if (editButton === undefined) throw new Error("Expected an Edit action");
    editButton.click();
    await element.updateComplete;

    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith({ ...machine("remote", REMOTE_NAME), status: "online" });
    expect(select).not.toHaveBeenCalled();
    expect(selectedButton(element).getAttribute("aria-expanded")).toBe("false");
    expect(shadowElements(element, ".machine-option")).toHaveLength(0);
    expect(shadowElements(element, ".machine-option-actions-toggle")).toHaveLength(0);
  });

  it("offers an edit menu for a remote machine without a remove handler", async () => {
    const element = await mountSwitcher("online");
    element.onEdit = vi.fn();
    await element.updateComplete;
    await openMenu(element);

    expect(shadowElements(element, ".machine-option-actions-toggle")).toHaveLength(1);
    shadowElement(element, ".machine-option-actions-toggle").click();
    await element.updateComplete;

    expect(shadowElements(element, ".machine-option-actions-panel button").map((button) => button.textContent)).toEqual(["Edit"]);
  });

  it("prefers session activity over terminal activity and suppresses it when the machine is offline or errored", async () => {
    const activity = (overrides: Partial<WorkspaceActivity>): Record<string, WorkspaceActivity> => ({
      "/repo": { cwd: "/repo", hasSessionActivity: false, hasTerminalActivity: false, updatedAt: "2026-10-17T00:00:00.000Z", ...overrides },
    });

    const both = await mountSwitcher("online");
    both.activities = { remote: activity({ hasSessionActivity: true, hasTerminalActivity: true }) };
    await both.updateComplete;
    expect(shadowElements(both, ".machine-switcher-button .activity-indicator.session")).toHaveLength(1);
    expect(shadowElements(both, ".machine-switcher-button .activity-indicator.terminal")).toHaveLength(0);
    document.body.replaceChildren();

    const terminalOnly = await mountSwitcher("online");
    terminalOnly.activities = { remote: activity({ hasTerminalActivity: true }) };
    await terminalOnly.updateComplete;
    expect(shadowElements(terminalOnly, ".machine-switcher-button .activity-indicator.terminal")).toHaveLength(1);
    expect(shadowElements(terminalOnly, ".machine-switcher-button .activity-indicator.session")).toHaveLength(0);
    document.body.replaceChildren();

    for (const status of ["offline", "error"] as const) {
      const suppressed = await mountSwitcher(status);
      suppressed.activities = { remote: activity({ hasSessionActivity: true, hasTerminalActivity: true }) };
      await suppressed.updateComplete;
      expect(shadowElements(suppressed, ".machine-switcher-button .activity-indicator")).toHaveLength(0);
      document.body.replaceChildren();
    }
  });
});
