import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActiveAgentProfileAccessError } from "./activeAgentProfileProvider.js";
import { PiWebUiPluginService, type PiPackageProvider } from "./piWebUiPluginService.js";

let tempDir: string;

const originalDockerRuntime = process.env["PI_WEBUI_DOCKER_RUNTIME"];
const originalDockerMode = process.env["PI_WEBUI_DOCKER_MODE"];
const originalDockerDevRepoRoot = process.env["PI_WEBUI_DOCKER_DEV_REPO_ROOT"];
const originalDockerInstallDir = process.env["PI_WEBUI_DOCKER_INSTALL_DIR"];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-plugin-service-test-"));
});

afterEach(async () => {
  restoreEnv("PI_WEBUI_DOCKER_RUNTIME", originalDockerRuntime);
  restoreEnv("PI_WEBUI_DOCKER_MODE", originalDockerMode);
  restoreEnv("PI_WEBUI_DOCKER_DEV_REPO_ROOT", originalDockerDevRepoRoot);
  restoreEnv("PI_WEBUI_DOCKER_INSTALL_DIR", originalDockerInstallDir);
  await rm(tempDir, { recursive: true, force: true });
});

describe("PiWebUiPluginService", () => {
  it("discovers local plugins and serves assets", async () => {
    const pluginDir = join(tempDir, "plugins", "info");
    await writePlugin(pluginDir, {
      packageJson: { piWebUi: { plugins: [{ id: "info", module: "pi-webui-plugin.js" }] } },
      files: { "pi-webui-plugin.js": "export default { apiVersion: 1, name: 'Info', activate: () => ({ contributions: {} }) };" },
    });

    const service = new PiWebUiPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    await expect(service.manifest()).resolves.toEqual({
      plugins: [expect.objectContaining({ id: "info", source: "test", scope: "local", machineSpecific: false })],
    });
    const manifest = await service.manifest();
    const module = manifest.plugins[0]?.module;
    expect(module).toMatch(/^\/pi-webui-plugins\/info\/pi-webui-plugin\.js\?v=\d+$/u);
    expect(new URL(module ?? "", "http://old-gateway.test/pi-webui-plugins/info/").pathname).toBe("/pi-webui-plugins/info/pi-webui-plugin.js");
    await expect(service.plugins()).resolves.toMatchObject({ plugins: [{ module }] });

    const asset = await service.readAsset("info", "pi-webui-plugin.js");
    expect(asset?.contentType).toBe("application/javascript; charset=utf-8");
    expect(asset?.content.toString("utf8")).toContain("export default");
  });

  it("preserves content types for extension-only asset names", async () => {
    const pluginDir = join(tempDir, "plugins", "extension-only");
    await writePlugin(pluginDir, {
      packageJson: { piWebUi: { plugins: [{ id: "extension-only", module: ".js" }] } },
      files: {
        ".js": "export default {};",
        ".svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      },
    });

    const service = new PiWebUiPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    await expect(service.readAsset("extension-only", ".js")).resolves.toMatchObject({ contentType: "application/javascript; charset=utf-8" });
    await expect(service.readAsset("extension-only", ".svg")).resolves.toMatchObject({ contentType: "image/svg+xml" });
  });

  it("serves nested SVG assets with a browser-compatible content type", async () => {
    const pluginDir = join(tempDir, "plugins", "icons");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>';
    await writePlugin(pluginDir, {
      packageJson: { piWebUi: { plugins: [{ id: "icons", module: "pi-webui-plugin.js" }] } },
      files: {
        "pi-webui-plugin.js": "export default {};",
        "assets/icon.svg": svg,
        "assets/uppercase.SVG": svg,
        "assets/data.bin": "unknown",
      },
    });

    const service = new PiWebUiPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const svgAsset = await service.readAsset("icons", "assets/icon.svg");
    expect(svgAsset?.contentType).toBe("image/svg+xml");
    expect(svgAsset?.content.toString("utf8")).toBe(svg);
    await expect(service.readAsset("icons", "assets/uppercase.SVG")).resolves.toMatchObject({ contentType: "image/svg+xml" });
    await expect(service.readAsset("icons", "assets/data.bin")).resolves.toMatchObject({ contentType: "application/octet-stream" });
  });

  it("includes machine-specific preferences in plugin manifests", async () => {
    await writePlugin(join(tempDir, "plugins", "updates"), {
      packageJson: { piWebUi: { plugins: [{ id: "updates", module: "pi-webui-plugin.js", machineSpecific: true }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });

    const service = new PiWebUiPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "updates", machineSpecific: true }] });
    await expect(service.plugins()).resolves.toMatchObject({ plugins: [{ id: "updates", machineSpecific: true, enabled: true }] });
  });

  it("adds Docker runtime hints to the Updates plugin module URL", async () => {
    process.env["PI_WEBUI_DOCKER_RUNTIME"] = "1";
    process.env["PI_WEBUI_DOCKER_MODE"] = "dev";
    await writePlugin(join(tempDir, "plugins", "updates"), {
      packageJson: { piWebUi: { plugins: [{ id: "updates", module: "pi-webui-plugin.js", machineSpecific: true }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });

    const service = new PiWebUiPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();
    const moduleUrl = new URL(manifest.plugins[0]?.module ?? "", "http://pi-webui.test/pi-webui-plugins/manifest.json");
    expect(moduleUrl.pathname).toBe("/pi-webui-plugins/updates/pi-webui-plugin.js");
    expect(moduleUrl.searchParams.get("v")).toMatch(/^\d+$/u);
    expect(moduleUrl.searchParams.get("piWebUiDockerMode")).toBe("dev");
  });

  it("discovers Pi package plugins through an injected package provider", async () => {
    const packageDir = join(tempDir, "pkg");
    await writePlugin(packageDir, {
      packageJson: { piWebUi: { plugins: [{ id: "review", module: "dist/review.js" }] } },
      files: { "dist/review.js": "export default { apiVersion: 1, name: 'Review', activate: () => ({ contributions: {} }) };" },
    });
    const packageProvider: PiPackageProvider = {
      listPackages: () => [{ source: "npm:@acme/review", scope: "user", installedPath: packageDir }],
      getInstalledPath: () => undefined,
    };

    const service = new PiWebUiPluginService({ roots: [], packageProvider });

    const manifest = await service.manifest();
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins[0]).toMatchObject({ id: "review", source: "npm:@acme/review", scope: "user" });
    expect(manifest.plugins[0]?.module).toMatch(/^\/pi-webui-plugins\/review\/dist\/review\.js\?v=\d+$/u);
  });

  it("uses the active agent directory on every Pi package plugin discovery", async () => {
    const packageDir = join(tempDir, "pkg");
    const initialAgentDir = join(tempDir, "initial-agent");
    const updatedAgentDir = join(tempDir, "updated-agent");
    let activeAgentDir = initialAgentDir;
    await writePlugin(packageDir, {
      packageJson: { piWebUi: { plugins: [{ id: "agent-package", module: "dist/plugin.js" }] } },
      files: { "dist/plugin.js": "export default {};" },
    });
    await mkdir(initialAgentDir, { recursive: true });
    await mkdir(updatedAgentDir, { recursive: true });
    await writeFile(join(updatedAgentDir, "settings.json"), `${JSON.stringify({ packages: [packageDir] }, null, 2)}\n`, "utf8");
    const service = new PiWebUiPluginService({ roots: [], cwd: tempDir, agentDirProvider: () => activeAgentDir });

    await expect(service.manifest()).resolves.toEqual({ plugins: [] });

    activeAgentDir = updatedAgentDir;

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "agent-package", source: packageDir, scope: "user" }] });
  });

  it("fails complete package-backed discovery closed while keeping known local assets independent", async () => {
    const pluginDir = join(tempDir, "plugins", "local-only");
    await writePlugin(pluginDir, {
      packageJson: { piWebUi: { plugins: [{ id: "local-only", module: "pi-webui-plugin.js" }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });
    const profileError = new ActiveAgentProfileAccessError({ status: "invalid", error: "missing descriptor" });
    const service = new PiWebUiPluginService({
      roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }],
      agentDirProvider: () => { throw profileError; },
    });

    await expect(service.manifest()).rejects.toBe(profileError);
    await expect(service.readAsset("local-only", "pi-webui-plugin.js")).resolves.toMatchObject({ contentType: "application/javascript; charset=utf-8" });
  });

  it("refreshes Pi package plugin discovery after Pi package settings change", async () => {
    const agentDir = join(tempDir, "agent");
    const firstPackageDir = join(tempDir, "first-package");
    const secondPackageDir = join(tempDir, "second-package");
    await writePlugin(firstPackageDir, {
      packageJson: { piWebUi: { plugins: [{ id: "first", module: "pi-webui-plugin.js" }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });
    await writePlugin(secondPackageDir, {
      packageJson: { piWebUi: { plugins: [{ id: "second", module: "pi-webui-plugin.js" }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });
    await writePiPackageSettings(agentDir, [firstPackageDir]);
    const service = new PiWebUiPluginService({ roots: [], cwd: tempDir, agentDir });

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "first" }] });

    await writePiPackageSettings(agentDir, [secondPackageDir]);

    const manifest = await service.manifest();
    expect(manifest.plugins.map((plugin) => plugin.id)).toEqual(["second"]);
  });

  it("discovers source checkout plugin packages without symlinks", async () => {
    await mkdir(join(tempDir, "src", "server"), { recursive: true });
    await writeFile(join(tempDir, "src", "server", "index.ts"), "export {};\n");
    await writePlugin(join(tempDir, "plugins", "source-dev"), {
      packageJson: { piWebUi: { plugins: [{ id: "source-dev", module: "dist/pi-webui-plugin.js" }] } },
      files: { "dist/pi-webui-plugin.js": "export default { apiVersion: 1, name: 'Source Dev', activate: () => ({ contributions: {} }) };" },
    });

    const service = new PiWebUiPluginService({ cwd: tempDir, packageProvider: false });

    const manifest = await service.manifest();
    expect(manifest.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "source-dev", source: "dev", scope: "local" }),
    ]));
    await expect(service.readAsset("source-dev", "dist/pi-webui-plugin.js")).resolves.toBeDefined();
  });

  it("discovers local plugins through symlinks for development", async () => {
    const pluginDir = join(tempDir, "dev-plugin");
    await writePlugin(pluginDir, {
      packageJson: { piWebUi: { plugins: [{ id: "dev", module: "pi-webui-plugin.js" }] } },
      files: { "pi-webui-plugin.js": "export default { apiVersion: 1, name: 'Dev', activate: () => ({ contributions: {} }) };" },
    });
    await mkdir(join(tempDir, "plugins"), { recursive: true });
    await symlink(pluginDir, join(tempDir, "plugins", "dev"), process.platform === "win32" ? "junction" : "dir");

    const service = new PiWebUiPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins[0]).toMatchObject({ id: "dev", source: "test", scope: "local" });
    await expect(service.readAsset("dev", "pi-webui-plugin.js")).resolves.toBeDefined();
  });

  it("filters disabled plugins from the manifest while reporting them through plugin status", async () => {
    await writePlugin(join(tempDir, "plugins", "enabled"), {
      packageJson: { piWebUi: { plugins: [{ id: "enabled", module: "pi-webui-plugin.js" }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });
    await writePlugin(join(tempDir, "plugins", "disabled"), {
      packageJson: { piWebUi: { plugins: [{ id: "disabled", module: "pi-webui-plugin.js" }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });

    const service = new PiWebUiPluginService({
      roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }],
      packageProvider: false,
      configProvider: () => ({ plugins: { disabled: { enabled: false, settings: { hidden: true } } } }),
    });

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "enabled" }] });
    await expect(service.plugins()).resolves.toMatchObject({
      plugins: [
        { id: "disabled", enabled: false },
        { id: "enabled", enabled: true },
      ],
    });
  });

  it("skips duplicate plugin ids", async () => {
    const firstRoot = join(tempDir, "first-root");
    const secondRoot = join(tempDir, "second-root");
    await writePlugin(join(firstRoot, "duplicate"), {
      packageJson: { piWebUi: { plugins: [{ id: "duplicate", module: "first.js" }] } },
      files: { "first.js": "export default {};" },
    });
    await writePlugin(join(secondRoot, "duplicate"), {
      packageJson: { piWebUi: { plugins: [{ id: "duplicate", module: "second.js", machineSpecific: true }] } },
      files: { "second.js": "export default {};" },
    });

    const service = new PiWebUiPluginService({
      roots: [
        { path: firstRoot, source: "first", scope: "local" },
        { path: secondRoot, source: "second", scope: "local" },
      ],
      packageProvider: false,
    });

    const manifest = await service.manifest();
    expect(manifest.plugins).toEqual([
      expect.objectContaining({ id: "duplicate", source: "first", machineSpecific: false }),
    ]);
    expect(manifest.plugins[0]?.module).toMatch(/^\/pi-webui-plugins\/duplicate\/first\.js\?v=\d+$/u);
  });

  it("skips legacy metadata shortcuts and unsafe module paths", async () => {
    const legacyRoot = join(tempDir, "legacy-root");
    await writePlugin(join(legacyRoot, "legacy"), {
      packageJson: { piWebUi: { id: "legacy", plugin: "pi-webui-plugin.js" } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });
    const unsafeRoot = join(tempDir, "unsafe-root");
    await writePlugin(join(unsafeRoot, "unsafe"), {
      packageJson: { piWebUi: { plugins: [{ id: "unsafe", module: "../escape.js" }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });

    await expect(new PiWebUiPluginService({ roots: [{ path: legacyRoot, source: "test", scope: "local" }], packageProvider: false }).manifest()).resolves.toEqual({ plugins: [] });
    await expect(new PiWebUiPluginService({ roots: [{ path: unsafeRoot, source: "test", scope: "local" }], packageProvider: false }).manifest()).resolves.toEqual({ plugins: [] });
  });

  it("continues discovering valid plugins when another local plugin is invalid", async () => {
    await writePlugin(join(tempDir, "plugins", "valid"), {
      packageJson: { piWebUi: { plugins: [{ id: "valid", module: "pi-webui-plugin.js" }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });
    await writePlugin(join(tempDir, "plugins", "legacy"), {
      packageJson: { piWebUi: { id: "legacy", plugin: "pi-webui-plugin.js" } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });

    const service = new PiWebUiPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();
    expect(manifest.plugins.map((plugin) => plugin.id)).toEqual(["valid"]);
  });

  it("rejects unsafe asset traversal", async () => {
    const pluginDir = join(tempDir, "plugins", "safe");
    await writePlugin(pluginDir, {
      packageJson: { piWebUi: { plugins: [{ id: "safe", module: "pi-webui-plugin.js" }] } },
      files: { "pi-webui-plugin.js": "export default {};" },
    });
    await writeFile(join(tempDir, "plugins", "escape.js"), "nope");

    const service = new PiWebUiPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();
    expect(manifest.plugins).toHaveLength(1);
    await expect(service.readAsset("safe", "../escape.js")).resolves.toBeUndefined();
  });
});

async function writePiPackageSettings(agentDir: string, packages: string[]): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages }, null, 2)}\n`);
}

async function writePlugin(root: string, options: { packageJson: unknown; files: Record<string, string> }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(options.packageJson, null, 2)}\n`);
  for (const [path, content] of Object.entries(options.files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}
