import type { SessionCreationSource } from "../../shared/apiTypes.js";
import { resolve } from "node:path";

export const SESSION_CREATION_SOURCE_CUSTOM_TYPE =
  "pi-webui.session-creation-source";

export interface SessionCreationOrigin {
  sessionId: string;
  sessionFile: string;
}

export type CreationSourceInspection =
  | { kind: "absent" }
  | {
      kind: "valid";
      source: SessionCreationSource;
      origin?: SessionCreationOrigin;
    }
  | { kind: "invalid"; reason: string };

export interface SessionCreationRootIdentity {
  sessionId: string;
  sessionFile: string;
  parentSession?: string;
}

export type SessionCreationRootEligibility =
  | { kind: "eligible" }
  | { kind: "ineligible"; reason: string };

export function serializeSessionCreationSource(
  source: SessionCreationSource,
  origin?: SessionCreationOrigin
): Record<string, unknown> {
  return origin === undefined
    ? { version: 1, source }
    : {
        version: 2,
        source,
        origin: {
          sessionId: origin.sessionId,
          sessionFile: origin.sessionFile,
        },
      };
}

export function inspectSessionCreationSource(
  entries: readonly unknown[]
): CreationSourceInspection {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isCreationSourceEntry(entry)) continue;

    try {
      return { kind: "valid", ...parseCreationSourceData(entry["data"]) };
    } catch (error) {
      return {
        kind: "invalid",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { kind: "absent" };
}

export function inspectSessionCreationRootEligibility(
  source: CreationSourceInspection,
  identity: SessionCreationRootIdentity
): SessionCreationRootEligibility {
  if (source.kind !== "valid")
    return { kind: "ineligible", reason: "the creation source is not valid" };
  if (identity.parentSession !== undefined && identity.parentSession !== "")
    return {
      kind: "ineligible",
      reason: "the session has a parent transcript",
    };
  if (source.origin === undefined)
    return {
      kind: "ineligible",
      reason: "the creation source has no bound root origin",
    };
  if (source.origin.sessionId !== identity.sessionId)
    return {
      kind: "ineligible",
      reason: "the creation origin does not match this session id",
    };
  if (resolve(source.origin.sessionFile) !== resolve(identity.sessionFile))
    return {
      kind: "ineligible",
      reason: "the creation origin does not match this session file",
    };
  return { kind: "eligible" };
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

function parseCreationSourceData(value: unknown): {
  source: SessionCreationSource;
  origin?: SessionCreationOrigin;
} {
  if (!isRecord(value)) throw new Error("creation source data must be an object");
  if (value["source"] !== "session-list-plus")
    throw new Error("unknown session creation source");
  if (value["version"] === 1) {
    assertExactKeys(value, ["version", "source"], "creation source data");
    return { source: value["source"] };
  }
  if (value["version"] === 2) {
    assertExactKeys(
      value,
      ["version", "source", "origin"],
      "creation source data"
    );
    const origin = value["origin"];
    if (!isRecord(origin))
      throw new Error("creation source origin must be an object");
    assertExactKeys(
      origin,
      ["sessionId", "sessionFile"],
      "creation source origin"
    );
    const sessionId = requireNonEmptyString(
      origin["sessionId"],
      "creation source origin sessionId"
    );
    const sessionFile = requireNonEmptyString(
      origin["sessionFile"],
      "creation source origin sessionFile"
    );
    return {
      source: value["source"],
      origin: { sessionId, sessionFile },
    };
  }
  throw new Error("unsupported creation source version");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
