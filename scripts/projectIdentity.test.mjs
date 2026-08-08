import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packageManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));

describe("project identity", () => {
  it("publishes PI WEBUI package executables", () => {
    expect(packageManifest.name).toBe("@hyperdreamer/pi-webui");
    expect(packageManifest.bin).toEqual({
      "pi-webui": "dist/cli.js",
      "pi-webui-server": "dist/server/index.js",
      "pi-webui-sessiond": "dist/server/sessiond.js",
    });
  });

  it("credits Federico Jaramillo Martinez and HyperDreamer as package authors while retaining the PI WEBUI repository identity", () => {
    expect(packageManifest.author).toBe("Federico Jaramillo Martinez and HyperDreamer");
    expect(packageManifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/hyperdreamer/pi-webui.git",
    });
    expect(packageManifest.bugs).toEqual({
      url: "https://github.com/hyperdreamer/pi-webui/issues",
    });
  });

  it("keeps the embedded Pi SDK dependencies aligned with its supported peer series", () => {
    expect(packageManifest.devDependencies).toMatchObject({
      "@earendil-works/pi-agent-core": "^0.84.0",
      "@earendil-works/pi-ai": "^0.84.0",
      "@earendil-works/pi-coding-agent": "^0.84.0",
    });
    expect(packageManifest.peerDependencies).toMatchObject({
      "@earendil-works/pi-agent-core": ">=0.84.0 <0.85",
      "@earendil-works/pi-ai": ">=0.84.0 <0.85",
      "@earendil-works/pi-coding-agent": ">=0.84.0 <0.85",
    });
  });

  it("exposes explicit fast and serial test profiles while keeping verification serial", () => {
    expect(packageManifest.scripts).toMatchObject({
      test: "vitest run --config vitest.config.ts",
      "test:fast": "vitest run --config vitest.config.ts --maxWorkers=4",
      "test:serial": "vitest run --config vitest.config.ts --maxWorkers=1",
      verify: "npm run typecheck && npm run lint && npm run knip && npm run test:serial",
    });
  });

  it("uses PI WEBUI plugin and extension paths", () => {
    expect(existsSync(join(repositoryRoot, "pi-webui-plugins"))).toBe(true);
    const legacyPluginDirectory = ["pi", "web-plugins"].join("-");
    expect(existsSync(join(repositoryRoot, legacyPluginDirectory))).toBe(false);
    expect(existsSync(join(repositoryRoot, "extensions", "pi-webui.ts"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "pi-webui-plugins", "updates", "pi-webui-plugin.ts"))).toBe(true);
  });
});
