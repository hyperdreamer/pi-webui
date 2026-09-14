/** @vitest-environment jsdom */
import { HttpRequestError, modelsConfigApi, type Machine, type ModelsConfigDocument, type ModelsConfigLimitsStatusResponse, type ModelsConfigSaveResponse } from "../api";
import { ModelsConfigRequestError } from "../api/modelsConfigError";
import { parseModelsConfigDocument } from "../api/parsers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsConfigDialog } from "./ModelsConfigDialog";

const DOCUMENT: ModelsConfigDocument = {
  providers: {
    acme: {
      api: "openai-completions",
      models: [{ id: "demo", tpm: 100, rpm: 60 }, { id: "other" }],
    },
  },
};

function machine(id: string): Machine {
  return {
    id,
    name: "Remote build host",
    kind: "remote",
    baseUrl: "https://remote.example.test/",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

interface MountOptions {
  document?: ModelsConfigDocument;
  documentError?: Error;
  limitsStatus?: ModelsConfigLimitsStatusResponse;
  limitsError?: Error;
  saveError?: Error;
}

const DEFAULT_LIMITS_STATUS: ModelsConfigLimitsStatusResponse = { contractVersion: 1, revision: 1, admission: "ready", source: "accepted-document" };
const SAVE_RESPONSE: ModelsConfigSaveResponse = { success: true, contractVersion: 1, revision: 2 };

async function mountDialog(options: MountOptions = {}) {
  const dialog = new ModelsConfigDialog();
  const modelsApi = {
    config: vi.fn<typeof modelsConfigApi.config>(() => options.documentError !== undefined ? Promise.reject(options.documentError) : Promise.resolve(options.document ?? DOCUMENT)),
    limitsStatus: vi.fn<typeof modelsConfigApi.limitsStatus>(() => options.limitsError !== undefined
      ? Promise.reject(options.limitsError)
      : Promise.resolve(options.limitsStatus ?? DEFAULT_LIMITS_STATUS)),
    save: vi.fn<typeof modelsConfigApi.save>(() => options.saveError !== undefined ? Promise.reject(options.saveError) : Promise.resolve(SAVE_RESPONSE)),
    test: vi.fn<typeof modelsConfigApi.test>(() => Promise.resolve({ ok: true, latencyMs: 4 })),
    discover: vi.fn<typeof modelsConfigApi.discover>(() => Promise.resolve({ models: [] })),
  };
  dialog.machine = machine("remote-a");
  dialog.modelsApi = modelsApi;
  document.body.append(dialog);
  await dialog.updateComplete;
  if (options.documentError === undefined) {
    await vi.waitFor(() => { expect(dialog.shadowRoot?.querySelector(".provider-row")).not.toBeNull(); });
  } else {
    // A failed document load renders the error state instead of the provider tree.
    await vi.waitFor(() => { expect(dialogLoading(dialog)).toBe(false); });
  }
  return { dialog, modelsApi };
}

function shadow(dialog: ModelsConfigDialog): ShadowRoot {
  const root = dialog.shadowRoot;
  if (root === null) throw new Error("Expected shadow root");
  return root;
}

async function selectModel(dialog: ModelsConfigDialog, index: number): Promise<void> {
  const row = shadow(dialog).querySelectorAll<HTMLButtonElement>(".model-row")[index];
  if (row === undefined) throw new Error(`Missing model row ${String(index)}`);
  row.click();
  await dialog.updateComplete;
}

async function inputText(dialog: ModelsConfigDialog, id: string, value: string): Promise<void> {
  const input = shadow(dialog).querySelector<HTMLInputElement>(`#${id}`);
  if (input === null) throw new Error(`Missing input #${id}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await dialog.updateComplete;
}

function saveButton(dialog: ModelsConfigDialog): HTMLButtonElement {
  const button = shadow(dialog).querySelector<HTMLButtonElement>("button.primary");
  if (button === null) throw new Error("Missing Save button");
  return button;
}

async function clickSave(dialog: ModelsConfigDialog): Promise<void> {
  saveButton(dialog).click();
  await dialog.updateComplete;
}

function footerText(dialog: ModelsConfigDialog): string {
  return shadow(dialog).querySelector("footer")?.textContent ?? "";
}

function dialogLoading(dialog: ModelsConfigDialog): boolean {
  const value: unknown = Reflect.get(dialog, "loading");
  if (typeof value !== "boolean") throw new Error("ModelsConfigDialog.loading is not a boolean");
  return value;
}

describe("ModelsConfigDialog rate limits", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the unframed Rate limits section between context and cost with Unlimited placeholders", async () => {
    const { dialog } = await mountDialog();
    await selectModel(dialog, 0);

    const section = shadow(dialog).querySelector("section.rate-limits-section");
    expect(section).not.toBeNull();
    expect(section?.querySelector(".section-label")?.textContent).toBe("Rate limits");
    expect(shadow(dialog).querySelector("#model-tpm")?.getAttribute("placeholder")).toBe("Unlimited");
    expect(shadow(dialog).querySelector("#model-rpm")?.getAttribute("placeholder")).toBe("Unlimited");
    const costSection = shadow(dialog).querySelector("section.cost-section");
    expect(section !== null && costSection !== null && (section.compareDocumentPosition(costSection) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });

  it("applies valid set and clear edits to the saved payload", async () => {
    const { dialog, modelsApi } = await mountDialog();
    await selectModel(dialog, 0);

    await inputText(dialog, "model-tpm", "250");
    await inputText(dialog, "model-rpm", "");
    await clickSave(dialog);
    await vi.waitFor(() => { expect(modelsApi.save).toHaveBeenCalledTimes(1); });

    const saved = modelsApi.save.mock.calls[0]?.[0];
    expect(saved).toEqual({ providers: { acme: { api: "openai-completions", models: [{ id: "demo", tpm: 250 }, { id: "other" }] } } });
    expect(footerText(dialog)).toContain("Saved and reloaded models");
  });

  it("blocks Save and shows the field error for invalid input", async () => {
    const { dialog, modelsApi } = await mountDialog();
    await selectModel(dialog, 0);

    await inputText(dialog, "model-tpm", "1e3");

    expect(saveButton(dialog).disabled).toBe(true);
    expect(shadow(dialog).querySelector("#model-tpm")?.closest(".field-stack")?.querySelector(".field-error")?.textContent)
      .toBe("Tokens per minute must be a whole number.");
    expect(modelsApi.save).not.toHaveBeenCalled();
  });

  it("blocks Save after navigating away from an invalid model and names the identity", async () => {
    const { dialog } = await mountDialog();
    await selectModel(dialog, 0);
    await inputText(dialog, "model-tpm", "1.5");
    await selectModel(dialog, 1);

    expect(saveButton(dialog).disabled).toBe(true);
    expect(footerText(dialog)).toContain("Fix rate limits for acme/demo before saving.");
  });

  it("blocks Save for a loaded invalid stored value", async () => {
    // models.json can hold a non-numeric value; the parser preserves it so the dialog can surface it.
    const { dialog } = await mountDialog({
      document: parseModelsConfigDocument({ providers: { acme: { models: [{ id: "demo", tpm: "bad" }] } } }),
    });
    await selectModel(dialog, 0);

    expect(saveButton(dialog).disabled).toBe(true);
    expect(shadow(dialog).querySelector("#model-tpm")?.closest(".field-stack")?.querySelector(".field-error")?.textContent)
      .toBe("Tokens per minute must be a whole number.");
  });

  it("disables Save and clears the tree when the document load fails", async () => {
    const { dialog } = await mountDialog({ documentError: new Error("parse failed") });

    await vi.waitFor(() => { expect(saveButton(dialog).disabled).toBe(true); });
    expect(shadow(dialog).querySelectorAll(".provider-row")).toHaveLength(0);
    expect(footerText(dialog)).toContain("Failed to load models configuration");
  });

  it("shows the blocked and last-known-good status banners", async () => {
    const blocked = await mountDialog({ limitsStatus: { contractVersion: 1, revision: 1, admission: "blocked", source: "none", error: "bad file" } });
    await vi.waitFor(() => { expect(footerText(blocked.dialog)).toContain("Model requests are blocked: bad file"); });

    const lastGood = await mountDialog({ limitsStatus: { contractVersion: 1, revision: 1, admission: "ready", source: "last-known-good", error: "parse failed" } });
    await vi.waitFor(() => { expect(footerText(lastGood.dialog)).toContain("Active limits come from the last accepted configuration: parse failed"); });
  });

  it("tolerates a 404 limits sidecar and keeps editing available", async () => {
    const { dialog, modelsApi } = await mountDialog({ limitsError: new HttpRequestError("Not Found", 404) });

    expect(footerText(dialog)).not.toContain("Failed to load rate-limit status");
    await selectModel(dialog, 0);
    expect(saveButton(dialog).disabled).toBe(false);
    expect(modelsApi.config).toHaveBeenCalled();
  });

  it("maps a structured INVALID_LIMITS save failure onto the offending field", async () => {
    const failure = new ModelsConfigRequestError("Requests per minute must be a whole number.", 400, {
      code: "MODELS_CONFIG_INVALID_LIMITS",
      file: "models.json",
      provider: "acme",
      modelId: "demo",
      field: "rpm",
      occurrence: 0,
      reason: "not-a-number",
    });
    const { dialog } = await mountDialog({ saveError: failure });
    await selectModel(dialog, 0);

    await clickSave(dialog);
    await vi.waitFor(() => {
      expect(shadow(dialog).querySelector("#model-rpm")?.closest(".field-stack")?.querySelector(".field-error")?.textContent)
        .toBe("Requests per minute must be a whole number.");
    });
    expect(saveButton(dialog).disabled).toBe(true);
  });

  it("keeps Test usable while a rate-limit draft is invalid and drops stale draft state on machine change", async () => {
    const { dialog } = await mountDialog();
    await selectModel(dialog, 0);
    await inputText(dialog, "model-tpm", "1e3");

    const testButton = [...shadow(dialog).querySelectorAll<HTMLButtonElement>("button.secondary")]
      .find((button) => button.textContent.includes("Test"));
    expect(testButton?.disabled).toBe(false);

    dialog.machine = machine("remote-b");
    await dialog.updateComplete;
    await vi.waitFor(() => { expect(shadow(dialog).querySelector(".provider-row")).not.toBeNull(); });
    await selectModel(dialog, 0);

    expect(shadow(dialog).querySelector<HTMLInputElement>("#model-tpm")?.value).toBe("100");
    expect(saveButton(dialog).disabled).toBe(false);
  });
});
