import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { patchSessionHistoryExportHtml } from "./sessionHistoryExport";

describe("patchSessionHistoryExportHtml", () => {
  it("adapts the installed Pi viewer's recursive tree helpers for long histories", async () => {
    const template = await readFile(join(getPackageDir(), "dist", "core", "export-html", "template.js"), "utf8");

    const patched = patchSessionHistoryExportHtml(template.replace(/\n/g, "\r\n"));

    expect(patched).toContain("function sortChildren(root)");
    expect(patched).toContain("const stack = [...tree].reverse();");
    expect(patched).toContain("const stack1 = [root];");
    expect(patched).not.toContain("node.children.forEach(sortChildren)");
    expect(patched).not.toContain("node.children.forEach(mapNodes)");
    expect(patched).not.toContain("if (markActive(child)) has = true;");
  });

  it("fails explicitly if Pi's viewer template changes incompatibly", () => {
    expect(() => patchSessionHistoryExportHtml("<html></html>")).toThrow(
      "Failed to patch exported HTML: sortChildren expected 1 match, found 0",
    );
  });
});
