import { describe, expect, it } from "vitest";
import {
  SESSION_CREATION_SOURCE_CUSTOM_TYPE,
  inspectSessionCreationSource,
  serializeSessionCreationSource,
} from "./sessionCreationSource.js";

function customSourceEntry(data: unknown): unknown {
  return {
    type: "custom",
    customType: SESSION_CREATION_SOURCE_CUSTOM_TYPE,
    data,
  };
}

describe("session creation source domain", () => {
  describe("serializeSessionCreationSource", () => {
    it("writes the strict version-one source shape", () => {
      expect(serializeSessionCreationSource("session-list-plus")).toEqual({
        version: 1,
        source: "session-list-plus",
      });
    });
  });

  describe("inspectSessionCreationSource", () => {
    it("reports an absent source when no matching entry exists", () => {
      expect(inspectSessionCreationSource([])).toEqual({ kind: "absent" });
      expect(
        inspectSessionCreationSource([
          { type: "custom", customType: "other.custom", data: {} },
        ])
      ).toEqual({ kind: "absent" });
    });

    it("returns the known source from a valid version-one entry", () => {
      expect(
        inspectSessionCreationSource([
          customSourceEntry({ version: 1, source: "session-list-plus" }),
        ])
      ).toEqual({ kind: "valid", source: "session-list-plus" });
    });

    it("uses the newest matching source entry", () => {
      expect(
        inspectSessionCreationSource([
          customSourceEntry({ version: 2, source: "session-list-plus" }),
          customSourceEntry({ version: 1, source: "session-list-plus" }),
        ])
      ).toEqual({ kind: "valid", source: "session-list-plus" });
    });

    it("does not revive an older source after the newest matching entry is malformed", () => {
      expect(
        inspectSessionCreationSource([
          customSourceEntry({ version: 1, source: "session-list-plus" }),
          customSourceEntry({ version: 1, source: "unknown" }),
        ])
      ).toMatchObject({ kind: "invalid" });
    });

    it.each([
      ["an unsupported version", { version: 2, source: "session-list-plus" }],
      ["a missing version", { source: "session-list-plus" }],
      ["a missing source", { version: 1 }],
      ["an unknown source", { version: 1, source: "unknown" }],
      [
        "an unknown field",
        { version: 1, source: "session-list-plus", future: true },
      ],
    ] as const)("rejects %s", (_description, data) => {
      expect(
        inspectSessionCreationSource([customSourceEntry(data)])
      ).toMatchObject({ kind: "invalid" });
    });
  });
});
