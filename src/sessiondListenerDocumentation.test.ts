import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const listenerClaims = [
  "Session daemon listener",
  "describes the two ends of one connection in the global config file.",
  "sessiond.host is inert without a port, and an absent sessiond.port still means the unix socket.",
  "An empty or whitespace-only string means absent on all three, so a file value still applies when its environment variable is blank.",
  "The daemon resolves its listener from the file subtree plus its own environment and reports the effective values with per-value provenance.",
  "binds 127.0.0.1 instead of the wildcard address.",
  "Set sessiond.host (or PI_WEBUI_SESSIOND_HOST) to 0.0.0.0 explicitly for a wildcard bind.",
  "Use 8810 as a safe sessiond.port choice; vite.config.ts reserves 8809 with strictPort: true for the dev client",
] as const;

const removedRuntimeOnlyRows = [
  "Session daemon TCP port",
  "Session daemon TCP host",
  "Web-to-daemon URL",
] as const;

describe("Session daemon listener documentation", () => {
  it("keeps Markdown and HTML listener claims synchronized", async () => {
    const [markdown, html] = await Promise.all([
      readRepoFile("docs/config.md"),
      readRepoFile("docs/config.html"),
    ]);

    for (const content of [markdown, html].map(documentText)) {
      for (const claim of listenerClaims) expect(content).toContain(claim);
    }
  });

  it("links the install guidance to the listener section and lists it in the HTML table of contents", async () => {
    const [html, install] = await Promise.all([
      readRepoFile("docs/config.html"),
      readRepoFile("docs/install.html"),
    ]);

    expect(html).toContain('<section id="session-daemon-listener">');
    expect(html).toContain('<a href="#session-daemon-listener">Session daemon listener</a>');
    expect(install).toContain("config#session-daemon-listener");
  });

  it("removes the runtime-only environment rows from both pages", async () => {
    const [markdown, html] = await Promise.all([
      readRepoFile("docs/config.md"),
      readRepoFile("docs/config.html"),
    ]);

    for (const content of [markdown, html]) {
      for (const row of removedRuntimeOnlyRows) expect(content).not.toContain(row);
    }
  });
});

function documentText(content: string): string {
  return content.replaceAll(/<[^>]+>|\*\*|`/g, "").replaceAll(/\s+/g, " ");
}

async function readRepoFile(relativePath: string): Promise<string> {
  return await readFile(join(repoRoot, relativePath), "utf8");
}
