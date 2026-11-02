// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Machine } from "../api";
import { MachineList, canEditMachine, canRemoveMachine } from "./MachineList";

const localMachine: Machine = machine("local", "local");
const remoteMachine: Machine = { ...machine("remote-a", "remote"), baseUrl: "https://remote.example.test" };

afterEach(() => {
  // Replacing the body disconnects the mount, which also removes its document listener.
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.restoreAllMocks();
});

describe("canRemoveMachine", () => {
  it("only allows remote machines to be removed from the machine list", () => {
    expect(canRemoveMachine(machine("local", "local"))).toBe(false);
    expect(canRemoveMachine(machine("remote-a", "remote"))).toBe(true);
  });
});

describe("canEditMachine", () => {
  it("only allows remote machines to be edited from the machine list", () => {
    expect(canEditMachine(machine("local", "local"))).toBe(false);
    expect(canEditMachine(machine("remote-a", "remote"))).toBe(true);
  });
});

describe("machine list actions", () => {
  it("edits the menu machine without selecting it", async () => {
    const edit = vi.fn();
    const select = vi.fn();
    const list = await renderMachineList((element) => {
      element.machines = [localMachine, remoteMachine];
      element.onEdit = edit;
      element.onSelect = select;
    });

    await clickMenuAction(list, remoteMachine, "Edit");

    expect(edit).toHaveBeenCalledWith(remoteMachine);
    expect(select).not.toHaveBeenCalled();
    expect(menuActions(list, localMachine)).toEqual([]);
  });

  it("keeps edit and remove as independent actions on one remote machine", async () => {
    const edit = vi.fn();
    const remove = vi.fn();
    const list = await renderMachineList((element) => {
      element.machines = [localMachine, remoteMachine];
      element.onEdit = edit;
      element.onRemove = remove;
    });

    await clickMenuAction(list, remoteMachine, "Edit");

    expect(edit).toHaveBeenCalledWith(remoteMachine);
    expect(remove).not.toHaveBeenCalled();

    await clickMenuAction(list, remoteMachine, "Remove");

    expect(remove).toHaveBeenCalledWith(remoteMachine);
    expect(edit).toHaveBeenCalledOnce();
  });

  it("offers an edit menu without a remove handler and hides local actions", async () => {
    const edit = vi.fn();
    const list = await renderMachineList((element) => {
      element.machines = [localMachine, remoteMachine];
      element.onEdit = edit;
    });

    await openMenu(list, remoteMachine);
    expect(menuActions(list, remoteMachine)).toEqual(["Edit"]);
    await toggleMenu(list, remoteMachine);

    await clickMenuAction(list, remoteMachine, "Edit");
    expect(edit).toHaveBeenCalledWith(remoteMachine);

    const localRow = rowFor(list, localMachine);
    expect(localRow.querySelector(".action-menu-toggle")).toBeNull();
    expect(localRow.classList.contains("no-actions")).toBe(true);
  });

  it("closes the edit menu after forwarding the action", async () => {
    const list = await renderMachineList((element) => {
      element.machines = [localMachine, remoteMachine];
      element.onEdit = vi.fn();
    });

    await clickMenuAction(list, remoteMachine, "Edit");

    expect(rowFor(list, remoteMachine).querySelector(".action-menu-panel")).toBeNull();
  });
});

async function renderMachineList(configure: (element: MachineList) => void): Promise<MachineList> {
  const list = new MachineList();
  configure(list);
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function listRoot(list: MachineList): ShadowRoot {
  const shadowRoot = list.shadowRoot;
  if (shadowRoot === null) throw new Error("Expected an open machine list shadow root");
  return shadowRoot;
}

function rowFor(list: MachineList, machine: Machine): HTMLElement {
  const rows = Array.from(listRoot(list).querySelectorAll<HTMLElement>(".machine-row"));
  const row = rows.find((candidate) => candidate.querySelector(".machine-primary-label")?.textContent === machine.name);
  if (row === undefined) throw new Error(`Expected a row for ${machine.name}`);
  return row;
}

async function openMenu(list: MachineList, machine: Machine): Promise<void> {
  const toggle = rowFor(list, machine).querySelector<HTMLButtonElement>(".action-menu-toggle");
  if (toggle === null) throw new Error(`Expected an actions menu for ${machine.name}`);
  toggle.click();
  await list.updateComplete;
}

/** Toggle a machine's menu with the same trigger a user presses. */
async function toggleMenu(list: MachineList, machine: Machine): Promise<void> {
  await openMenu(list, machine);
}

/** The action labels the machine's open menu renders. */
function menuActions(list: MachineList, machine: Machine): string[] {
  return Array.from(rowFor(list, machine).querySelectorAll<HTMLButtonElement>(".action-menu-panel button"))
    .map((button) => button.textContent.trim());
}

/** Click a menu action, opening the menu first exactly as a user would. */
async function clickMenuAction(list: MachineList, machine: Machine, label: string): Promise<void> {
  await openMenu(list, machine);
  const button = Array.from(rowFor(list, machine).querySelectorAll<HTMLButtonElement>(".action-menu-panel button"))
    .find((candidate) => candidate.textContent.trim() === label);
  if (button === undefined) throw new Error(`Expected a ${label} action for ${machine.name}`);
  button.click();
  await list.updateComplete;
}

function machine(id: string, kind: Machine["kind"]): Machine {
  return {
    id,
    name: id,
    kind,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}
