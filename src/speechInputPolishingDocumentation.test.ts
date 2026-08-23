import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const polishingLimitClaims = [
  "Transcript polishing accepts at most two concurrent requests.",
  "Each request has a 30-second client and route deadline; the utility-model provider has 25 seconds, leaving five seconds for cancellation, cleanup, and the HTTP response.",
  "Input and polished output are each limited to 1 MiB of UTF-8 text.",
  "If polishing times out or fails, PI WEBUI inserts the original transcript instead.",
] as const;

describe("Speech input polishing documentation", () => {
  it("keeps Markdown and HTML polishing limits synchronized", async () => {
    const [markdown, html] = await Promise.all([
      readRepoFile("docs/config.md"),
      readRepoFile("docs/config.html"),
    ]);

    for (const content of [markdown, html].map(documentText)) {
      expect(content).toContain("Capture, transcription, and polishing limits");
      for (const claim of polishingLimitClaims) expect(content).toContain(claim);
    }
  });
});

function documentText(content: string): string {
  return content.replaceAll(/<[^>]+>|\*\*/g, "").replaceAll(/\s+/g, " ");
}

async function readRepoFile(relativePath: string): Promise<string> {
  return await readFile(join(repoRoot, relativePath), "utf8");
}
