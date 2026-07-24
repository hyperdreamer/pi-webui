import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = "pi-webui-plugins";
const forbiddenPatterns = [
  { pattern: /\bfetch\s*\(/u, message: "direct browser fetch" },
  { pattern: /["'`][^"'`]*\/api\//u, message: "direct PI WEBUI /api URL" },
  { pattern: /piWebUiInternal/u, message: "legacy internal plugin context" },
  { pattern: /(?:\.\.\/)+src\//u, message: "imports from PI WEBUI source internals" },
];

describe("bundled PI WEBUI plugins", () => {
  it("use public plugin APIs instead of direct PI WEBUI internals", async () => {
    const violations: string[] = [];
    for (const file of await pluginSourceFiles(pluginRoot)) {
      const content = await readFile(file, "utf8");
      for (const { pattern, message } of forbiddenPatterns) {
        if (pattern.test(content)) violations.push(`${file}: ${message}`);
      }
      if (content.includes("piWebUiUnstable") && !content.includes("@hyperdreamer/pi-webui/plugin-api/unstable")) {
        violations.push(`${file}: piWebUiUnstable use without explicit unstable type import`);
      }
    }

    expect(violations).toEqual([]);
  });
});

async function pluginSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await pluginSourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}
