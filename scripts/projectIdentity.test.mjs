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

  it("uses PI WEBUI plugin and extension paths", () => {
    expect(existsSync(join(repositoryRoot, "pi-webui-plugins"))).toBe(true);
    const legacyPluginDirectory = ["pi", "web-plugins"].join("-");
    expect(existsSync(join(repositoryRoot, legacyPluginDirectory))).toBe(false);
    expect(existsSync(join(repositoryRoot, "extensions", "pi-webui.ts"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "pi-webui-plugins", "updates", "pi-webui-plugin.ts"))).toBe(true);
  });
});
