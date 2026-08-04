import { describe, expect, it } from "vitest";
import {
  SESSION_CREATION_SOURCE_CUSTOM_TYPE,
  inspectSessionCreationRootEligibility,
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

    it("binds a version-two source to the creating session id and file", () => {
      expect(
        serializeSessionCreationSource("session-list-plus", {
          sessionId: "root-session",
          sessionFile: "/sessions/root-session.jsonl",
        })
      ).toEqual({
        version: 2,
        source: "session-list-plus",
        origin: {
          sessionId: "root-session",
          sessionFile: "/sessions/root-session.jsonl",
        },
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

    it("returns the bound origin from a valid version-two entry", () => {
      expect(
        inspectSessionCreationSource([
          customSourceEntry({
            version: 2,
            source: "session-list-plus",
            origin: {
              sessionId: "root-session",
              sessionFile: "/sessions/root-session.jsonl",
            },
          }),
        ])
      ).toEqual({
        kind: "valid",
        source: "session-list-plus",
        origin: {
          sessionId: "root-session",
          sessionFile: "/sessions/root-session.jsonl",
        },
      });
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
      ["a version two source without an origin", { version: 2, source: "session-list-plus" }],
      ["a missing version", { source: "session-list-plus" }],
      ["a missing source", { version: 1 }],
      ["an unknown source", { version: 1, source: "unknown" }],
      [
        "an unknown field",
        { version: 1, source: "session-list-plus", future: true },
      ],
      [
        "an incomplete version two origin",
        {
          version: 2,
          source: "session-list-plus",
          origin: { sessionId: "root-session" },
        },
      ],
      [
        "an empty version two origin id",
        {
          version: 2,
          source: "session-list-plus",
          origin: {
            sessionId: "",
            sessionFile: "/sessions/root-session.jsonl",
          },
        },
      ],
    ] as const)("rejects %s", (_description, data) => {
      expect(
        inspectSessionCreationSource([customSourceEntry(data)])
      ).toMatchObject({ kind: "invalid" });
    });
  });

  describe("root eligibility", () => {
    const boundSource = inspectSessionCreationSource([
      customSourceEntry({
        version: 2,
        source: "session-list-plus",
        origin: {
          sessionId: "root-session",
          sessionFile: "/sessions/root-session.jsonl",
        },
      }),
    ]);

    function inspect(identity: {
      sessionId: string;
      sessionFile: string;
      parentSession?: string;
    }) {
      return inspectSessionCreationRootEligibility(boundSource, identity);
    }

    it("accepts only the bound top-level root identity", () => {
      expect(
        inspect({
          sessionId: "root-session",
          sessionFile: "/sessions/root-session.jsonl",
        })
      ).toEqual({ kind: "eligible" });
    });

    it.each([
      [
        "a parent transcript",
        {
          sessionId: "root-session",
          sessionFile: "/sessions/root-session.jsonl",
          parentSession: "/sessions/parent.jsonl",
        },
      ],
      [
        "a copied session id",
        {
          sessionId: "derived-session",
          sessionFile: "/sessions/root-session.jsonl",
        },
      ],
      [
        "a copied session file",
        {
          sessionId: "root-session",
          sessionFile: "/imports/root-session.jsonl",
        },
      ],
    ])("rejects %s", (_description, identity) => {
      expect(inspect(identity)).toMatchObject({ kind: "ineligible" });
    });

    it("rejects a valid legacy marker that has no bound origin", () => {
      const legacy = inspectSessionCreationSource([
        customSourceEntry({ version: 1, source: "session-list-plus" }),
      ]);

      expect(
        inspectSessionCreationRootEligibility(legacy, {
          sessionId: "root-session",
          sessionFile: "/sessions/root-session.jsonl",
        })
      ).toMatchObject({ kind: "ineligible" });
    });
  });
});
