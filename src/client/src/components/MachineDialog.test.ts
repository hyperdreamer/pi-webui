// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Machine } from "../api";
import { MachineDialog, machineBaseUrlValidationMessage, suggestedMachineNameFromUrl, type MachineDialogSubmit } from "./MachineDialog";

const INVALID_TIMEOUT_MESSAGE = "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds";

const remoteMachine: Machine = {
  id: "remote-lab",
  name: "Remote Lab",
  kind: "remote",
  baseUrl: "https://lab.example.test:8808",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

afterEach(() => {
  // Replacing the body disconnects the mount; the dialog owns no document listener.
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.restoreAllMocks();
});

describe("suggestedMachineNameFromUrl", () => {
  it("suggests the host without protocol or port", () => {
    expect(suggestedMachineNameFromUrl("http://127.0.0.1:8808")).toBe("127.0.0.1");
    expect(suggestedMachineNameFromUrl("https://devbox.example.test:8808/pi-webui")).toBe("devbox.example.test");
  });

  it("also suggests a host while the URL protocol is being typed", () => {
    expect(suggestedMachineNameFromUrl("devbox.local:8808")).toBe("devbox.local");
  });
});

describe("machineBaseUrlValidationMessage", () => {
  it("accepts http and https base URLs", () => {
    expect(machineBaseUrlValidationMessage("http://127.0.0.1:8808")).toBeUndefined();
    expect(machineBaseUrlValidationMessage("https://devbox.example.test/pi-webui")).toBeUndefined();
  });

  it("explains invalid machine URLs", () => {
    expect(machineBaseUrlValidationMessage("")).toBe("Remote PI WEBUI URL is required.");
    expect(machineBaseUrlValidationMessage("devbox.local:8808")).toBe("Use an http:// or https:// URL.");
    expect(machineBaseUrlValidationMessage("ftp://devbox.example.test")).toBe("Use an http:// or https:// URL.");
    expect(machineBaseUrlValidationMessage("https://user@devbox.example.test")).toBe("Do not include credentials in the machine URL.");
    expect(machineBaseUrlValidationMessage("https://devbox.example.test?q=1")).toBe("Do not include a query string or fragment.");
  });
});

describe("machine dialog request timeout", () => {
  it("edits patience in seconds and retains rejected input", async () => {
    const submitted: MachineDialogSubmit[] = [];
    const dialog = await renderMachineDialog((element) => {
      element.machine = remoteMachine;
      element.focusRequestTimeout = true;
      element.onSubmit = (input) => { submitted.push(input); };
    });

    expect(inputValue(dialog, "requestTimeoutMs")).toBe("120");
    expect(dialog.shadowRoot?.activeElement).toBe(timeoutInput(dialog));

    setInput(dialog, "requestTimeoutMs", "5.001");
    await submit(dialog);
    expect(submitted[0]).toMatchObject({ requestTimeoutMs: 5_001 });
    expect(submitted[0]).not.toHaveProperty("token");

    setInput(dialog, "requestTimeoutMs", "1e2");
    await submit(dialog);

    expect(inputValue(dialog, "requestTimeoutMs")).toBe("1e2");
    expect(dialogText(dialog)).toContain("Request timeout");
    expect(dialogText(dialog)).toContain(INVALID_TIMEOUT_MESSAGE);
    expect(dialog.shadowRoot?.activeElement).toBe(timeoutInput(dialog));
    expect(timeoutInput(dialog).matches(":focus")).toBe(true);
    expect(submitted).toHaveLength(1);
  });

  it("seeds the create dialog with the default and the edit dialog from the stored value", async () => {
    const create = await renderMachineDialog();
    expect(inputValue(create, "requestTimeoutMs")).toBe("120");
    document.body.replaceChildren();

    const stored = await renderMachineDialog((element) => { element.machine = { ...remoteMachine, requestTimeoutMs: 90_000 }; });
    expect(inputValue(stored, "requestTimeoutMs")).toBe("90");
    document.body.replaceChildren();

    const millisecondPrecision = await renderMachineDialog((element) => { element.machine = { ...remoteMachine, requestTimeoutMs: 5_001 }; });
    expect(inputValue(millisecondPrecision, "requestTimeoutMs")).toBe("5.001");
  });

  it("rejects a whole-second value that the shared validator refuses", async () => {
    const submitted: MachineDialogSubmit[] = [];
    const dialog = await renderMachineDialog((element) => {
      element.machine = remoteMachine;
      element.onSubmit = (input) => { submitted.push(input); };
    });

    setInput(dialog, "requestTimeoutMs", "3");
    await submit(dialog);

    expect(submitted).toHaveLength(0);
    expect(dialogText(dialog)).toContain(INVALID_TIMEOUT_MESSAGE);
    expect(inputValue(dialog, "requestTimeoutMs")).toBe("3");
  });

  it("rejects forbidden numeric syntax even when its coercion would land in range", async () => {
    const submitted: MachineDialogSubmit[] = [];
    const dialog = await renderMachineDialog((element) => {
      element.machine = remoteMachine;
      element.onSubmit = (input) => { submitted.push(input); };
    });

    // Every one of these coerces to 5 000 ms, inside the accepted bounds, so
    // only the lexical pattern can reject them.
    for (const value of ["5e3", "+5000", "5000.", "5000.0000", "0x1388"]) {
      setInput(dialog, "requestTimeoutMs", value);
      await submit(dialog);

      expect(submitted).toHaveLength(0);
      expect(dialogText(dialog)).toContain(INVALID_TIMEOUT_MESSAGE);
      expect(inputValue(dialog, "requestTimeoutMs")).toBe(value);
    }
  });

  it("keeps a rejected value and its message across rerenders", async () => {
    const dialog = await renderMachineDialog((element) => { element.machine = remoteMachine; });
    setInput(dialog, "requestTimeoutMs", "0.5");
    await submit(dialog);

    dialog.error = "Server refused the update";
    await dialog.updateComplete;

    expect(inputValue(dialog, "requestTimeoutMs")).toBe("0.5");
    expect(dialogText(dialog)).toContain(INVALID_TIMEOUT_MESSAGE);
    expect(dialogText(dialog)).toContain("Server refused the update");
  });

  it("resets rejected patience when the edited machine changes", async () => {
    const dialog = await renderMachineDialog((element) => { element.machine = remoteMachine; });
    setInput(dialog, "requestTimeoutMs", "1e2");
    await submit(dialog);
    expect(dialogText(dialog)).toContain(INVALID_TIMEOUT_MESSAGE);

    dialog.machine = { ...remoteMachine, id: "remote-two", requestTimeoutMs: 180_000 };
    await dialog.updateComplete;

    expect(inputValue(dialog, "requestTimeoutMs")).toBe("180");
    expect(dialogText(dialog)).not.toContain(INVALID_TIMEOUT_MESSAGE);
  });
});

async function renderMachineDialog(configure: (element: MachineDialog) => void = () => undefined): Promise<MachineDialog> {
  const dialog = new MachineDialog();
  configure(dialog);
  document.body.append(dialog);
  await dialog.updateComplete;
  return dialog;
}

function dialogRoot(dialog: MachineDialog): ShadowRoot {
  const shadowRoot = dialog.shadowRoot;
  if (shadowRoot === null) throw new Error("Expected an open dialog shadow root");
  return shadowRoot;
}

function dialogText(dialog: MachineDialog): string {
  return dialogRoot(dialog).textContent;
}

function timeoutInput(dialog: MachineDialog): HTMLInputElement {
  const found = dialogRoot(dialog).querySelector<HTMLInputElement>("input[name='requestTimeoutMs']");
  if (found === null) throw new Error("Expected the request timeout input");
  return found;
}

function inputValue(dialog: MachineDialog, name: string): string {
  const found = dialogRoot(dialog).querySelector<HTMLInputElement>(`input[name='${name}']`);
  if (found === null) throw new Error(`Expected the ${name} input`);
  return found.value;
}

function setInput(dialog: MachineDialog, name: string, value: string): void {
  const found = dialogRoot(dialog).querySelector<HTMLInputElement>(`input[name='${name}']`);
  if (found === null) throw new Error(`Expected the ${name} input`);
  found.value = value;
  found.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
}

/** Submit the dialog form and drain the async submit path it starts. */
async function submit(dialog: MachineDialog): Promise<void> {
  const form = dialogRoot(dialog).querySelector("form");
  if (form === null) throw new Error("Expected the dialog form");
  form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, composed: true }));
  await flush();
  await dialog.updateComplete;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
