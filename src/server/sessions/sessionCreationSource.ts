import type { SessionCreationSource } from "../../shared/apiTypes.js";

export const SESSION_CREATION_SOURCE_CUSTOM_TYPE =
  "pi-webui.session-creation-source";

export type CreationSourceInspection =
  | { kind: "absent" }
  | { kind: "valid"; source: SessionCreationSource }
  | { kind: "invalid"; reason: string };

export function serializeSessionCreationSource(
  source: SessionCreationSource
): Record<string, unknown> {
  return { version: 1, source };
}

export function inspectSessionCreationSource(
  entries: readonly unknown[]
): CreationSourceInspection {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isCreationSourceEntry(entry)) continue;

    try {
      return { kind: "valid", source: parseCreationSourceData(entry["data"]) };
    } catch (error) {
      return {
        kind: "invalid",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { kind: "absent" };
}

function isCreationSourceEntry(
  value: unknown
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value["type"] === "custom" &&
    value["customType"] === SESSION_CREATION_SOURCE_CUSTOM_TYPE
  );
}

function parseCreationSourceData(value: unknown): SessionCreationSource {
  if (!isRecord(value)) throw new Error("creation source data must be an object");
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, "version") ||
    !Object.hasOwn(value, "source")
  ) {
    throw new Error("creation source data must contain exactly version and source");
  }
  if (value["version"] !== 1)
    throw new Error("unsupported creation source version");
  if (value["source"] !== "session-list-plus")
    throw new Error("unknown session creation source");
  return value["source"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
