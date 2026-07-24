import { describe, expect, it } from "vitest";
import { parsePiPackagePluginsResponse } from "./parsers";

const extensionResource = { kind: "extension", name: "tools", path: "/packages/tools/extensions/index.ts", relativePath: "extensions/index.ts" };
const packageInfo = {
  source: "npm:@acme/tools@1.2.3",
  scope: "global",
  filtered: false,
  disabled: false,
  installedPath: "/home/test/.pi/agent/npm/node_modules/@acme/tools",
  packageName: "@acme/tools",
  version: "1.2.3",
  configuredVersion: "1.2.3",
  counts: { extensions: 1, skills: 2, prompts: 0, themes: 1 },
  resources: [
    extensionResource,
    { kind: "skill", name: "review", path: "/packages/tools/skills/review/SKILL.md", relativePath: "skills/review/SKILL.md" },
  ],
  status: "loaded",
};

const response = {
  packages: [packageInfo],
  totals: { extensions: 1, skills: 2, prompts: 0, themes: 1 },
  diagnostics: [{ type: "warning", source: "npm:@acme/missing", message: "Package is configured but not installed yet." }],
};

describe("Pi package Plugins response parser", () => {
  it("parses package status, resolved resources, diagnostics, and scope", () => {
    expect(parsePiPackagePluginsResponse(response)).toEqual(response);
  });

  it("rejects malformed package status data before it reaches the Plugins dialog", () => {
    expect(() => parsePiPackagePluginsResponse({
      ...response,
      packages: [{ ...packageInfo, scope: "user" }],
    })).toThrow("Pi package plugin scope");
    expect(() => parsePiPackagePluginsResponse({
      ...response,
      packages: [{ ...packageInfo, counts: { ...packageInfo.counts, skills: "two" } }],
    })).toThrow("skills");
    expect(() => parsePiPackagePluginsResponse({
      ...response,
      packages: [{ ...packageInfo, resources: [{ ...extensionResource, kind: "command" }] }],
    })).toThrow("resource kind");
  });
});
