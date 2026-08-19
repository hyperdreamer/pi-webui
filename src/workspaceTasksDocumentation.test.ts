import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manualRepairGuidance = "Repair malformed global data through normal PI WEBUI configuration administration";
const refreshGuidance = "then use Refresh in the Tasks panel to load the repaired catalog.";

describe("Workspace Tasks configuration documentation", () => {
  it("directs malformed global catalog recovery to manual repair followed by Refresh", async () => {
    const [markdown, html] = await Promise.all([
      readRepoFile("docs/config.md"),
      readRepoFile("docs/config.html"),
    ]);

    for (const content of [markdown, html].map(documentText)) {
      expect(content).toContain(manualRepairGuidance);
      expect(content).toContain(refreshGuidance);
      expect(content).not.toContain("Project-file reset");
    }
  });
});

function documentText(content: string): string {
  return content.replaceAll(/<[^>]+>|\*\*/g, "").replaceAll(/\s+/g, " ");
}

async function readRepoFile(relativePath: string): Promise<string> {
  return await readFile(join(repoRoot, relativePath), "utf8");
}
