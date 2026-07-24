import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("production client build contents", () => {
  it("uses the same self-contained speech-bubble pi mark for the app and documentation favicons", async () => {
    const [appIcon, documentationIcon] = await Promise.all([
      readFile(join(repoRoot, "src/client/public/favicon.svg"), "utf8"),
      readFile(join(repoRoot, "docs/assets/favicon.svg"), "utf8"),
    ]);

    expect(appIcon).toContain('viewBox="0 0 512 512"');
    expect(appIcon).toContain('<title id="title">PI WEBUI icon</title>');
    expect(appIcon).toContain('<desc id="desc">A thin green rounded speech-bubble outline framing a bold mathematical pi symbol.</desc>');
    expect(appIcon).toContain('id="speech-bubble"');
    expect(appIcon).toContain('stroke="#1E9E4A"');
    expect(appIcon).toContain('stroke-width="32"');
    expect(appIcon).toContain('id="pi-symbol"');
    expect(appIcon).toContain('fill="#1E9E4A"');
    expect(appIcon).toContain('transform="translate(121 311) scale(.17 -.17)"');
    expect(appIcon).not.toMatch(/<text\b/u);
    expect(documentationIcon).toBe(appIcon);
  });

  it("emits deployment-relative HTML and PWA URLs", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "pi-webui-client-build-"));
    try {
      await build({
        configFile: join(repoRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });

      const html = await readFile(join(outDir, "index.html"), "utf8");
      const references = htmlAssetReferences(html);
      expect(references).toContain("./favicon.svg");
      expect(references).toContain("./apple-touch-icon.png");
      expect(references).toContain("./manifest.webmanifest");
      expect(references).toContainEqual(expect.stringMatching(/^\.\/assets\/index-[^/]+\.js$/));
      expect(references.filter((reference) => reference.startsWith("/"))).toEqual([]);

      const manifest: unknown = JSON.parse(await readFile(join(outDir, "manifest.webmanifest"), "utf8"));
      expect(manifest).toMatchObject({
        start_url: "./",
        scope: "./",
        icons: [
          { src: "./pwa-icon-192.png" },
          { src: "./pwa-icon-512.png" },
        ],
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

function htmlAssetReferences(html: string): string[] {
  return Array.from(html.matchAll(/\b(?:href|src)="([^"]+)"/g), (match) => match[1] ?? "");
}
