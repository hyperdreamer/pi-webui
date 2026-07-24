import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveAgentProfileProvider } from "./activeAgentProfileProvider.js";
import { ActiveProfilePiPackagePluginsConfigService, DefaultPiPackagePluginsConfigService, type PiPackagePluginsConfigService } from "./piPackagePluginsConfigService.js";

const source = "npm:@acme/tools@1.2.3";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function resolvedResources() {
  return {
    extensions: [{
      path: "/packages/tools/extensions/index.ts",
      enabled: true,
      metadata: { source, scope: "user" as const, origin: "package" as const, baseDir: "/packages/tools" },
    }],
    skills: [{
      path: "/packages/tools/skills/review/SKILL.md",
      enabled: true,
      metadata: { source, scope: "user" as const, origin: "package" as const, baseDir: "/packages/tools" },
    }],
    prompts: [],
    themes: [],
  };
}

describe("DefaultPiPackagePluginsConfigService", () => {
  it("reports configured package resources, diagnostics, and disabled state for a workspace", async () => {
    let globalPackages: PackageSource[] = [source];
    let projectPackages: PackageSource[] = [];
    const flush = vi.fn().mockResolvedValue(undefined);
    const packageManager = {
      resolve: vi.fn().mockResolvedValue(resolvedResources()),
      listConfiguredPackages: vi.fn(() => [{ source, scope: "user" as const, filtered: false, installedPath: "/packages/tools" }]),
      installAndPersist: vi.fn().mockResolvedValue(undefined),
      removeAndPersist: vi.fn().mockResolvedValue(true),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const settingsManager = {
      getGlobalSettings: () => ({ packages: globalPackages }),
      getProjectSettings: () => ({ packages: projectPackages }),
      setPackages: (packages: PackageSource[]) => { globalPackages = packages; },
      setProjectPackages: (packages: PackageSource[]) => { projectPackages = packages; },
      flush,
    };
    const service = new DefaultPiPackagePluginsConfigService("/agent", () => ({ packageManager, settingsManager }));

    await expect(service.list("/repo")).resolves.toMatchObject({
      packages: [{
        source,
        scope: "global",
        status: "loaded",
        counts: { extensions: 1, skills: 1, prompts: 0, themes: 0 },
        resources: [
          { kind: "extension", name: "extensions", relativePath: "extensions/index.ts" },
          { kind: "skill", name: "review", relativePath: "skills/review/SKILL.md" },
        ],
      }],
      totals: { extensions: 1, skills: 1, prompts: 0, themes: 0 },
      diagnostics: [],
    });

    const disabled = await service.mutate({ action: "disable", source, scope: "global", cwd: "/repo" });

    expect(globalPackages).toEqual([{ source, extensions: [], skills: [], prompts: [], themes: [] }]);
    expect(flush).toHaveBeenCalledOnce();
    expect(disabled.packages[0]).toMatchObject({ disabled: true, status: "disabled" });

    await service.mutate({ action: "enable", source, scope: "global", cwd: "/repo" });
    expect(globalPackages).toEqual([source]);

    await service.mutate({ action: "install", source: "npm:@acme/new-tools", scope: "project", cwd: "/repo" });
    await service.mutate({ action: "remove", source: "npm:@acme/new-tools", scope: "project", cwd: "/repo" });
    await service.mutate({ action: "update", source, cwd: "/repo" });
    expect(packageManager.installAndPersist).toHaveBeenCalledWith("npm:@acme/new-tools", { local: true });
    expect(packageManager.removeAndPersist).toHaveBeenCalledWith("npm:@acme/new-tools", { local: true });
    expect(packageManager.update).toHaveBeenCalledWith(source);
  });

  it("uses Pi's actual package manager to resolve conventional package resources", async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const packagePath = join(root, "package");
    await mkdir(join(packagePath, "extensions"), { recursive: true });
    await mkdir(join(packagePath, "skills", "review"), { recursive: true });
    await writeFile(join(packagePath, "package.json"), JSON.stringify({ name: "@acme/local-tools", version: "1.2.3" }), "utf8");
    await writeFile(join(packagePath, "extensions", "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(join(packagePath, "skills", "review", "SKILL.md"), "---\nname: review\n---\nReview changes.\n", "utf8");

    const service = new DefaultPiPackagePluginsConfigService(agentDir);
    const response = await service.mutate({ action: "install", source: packagePath, scope: "global", cwd });

    expect(response.packages).toMatchObject([{
      source: relative(agentDir, packagePath),
      scope: "global",
      packageName: "@acme/local-tools",
      version: "1.2.3",
      status: "loaded",
      counts: { extensions: 1, skills: 1 },
    }]);
    expect(response.packages[0]?.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "extension", name: "extensions" }),
      expect.objectContaining({ kind: "skill", name: "review" }),
    ]));
  });

  it("records missing configured packages without attempting an implicit install", async () => {
    const packageManager = {
      resolve: vi.fn(async (onMissing: ((missing: string) => Promise<"skip">) | undefined) => {
        await onMissing?.("npm:@acme/missing");
        return { extensions: [], skills: [], prompts: [], themes: [] };
      }),
      listConfiguredPackages: vi.fn(() => [{ source: "npm:@acme/missing", scope: "user" as const, filtered: false }]),
      installAndPersist: vi.fn(),
      removeAndPersist: vi.fn(),
      update: vi.fn(),
    };
    const globalPackages: PackageSource[] = ["npm:@acme/missing"];
    const projectPackages: PackageSource[] = [];
    const settingsManager = {
      getGlobalSettings: () => ({ packages: globalPackages }),
      getProjectSettings: () => ({ packages: projectPackages }),
      setPackages: () => undefined,
      setProjectPackages: () => undefined,
      flush: () => Promise.resolve(),
    };
    const service = new DefaultPiPackagePluginsConfigService("/agent", () => ({ packageManager, settingsManager }));

    const response = await service.list("/repo");

    expect(response.packages).toMatchObject([{ source: "npm:@acme/missing", status: "missing" }]);
    expect(response.diagnostics).toContainEqual({
      type: "warning",
      source: "npm:@acme/missing",
      message: "Package is configured but not installed yet.",
    });
    expect(packageManager.installAndPersist).not.toHaveBeenCalled();
  });

  it("uses the profile active when each package Plugins operation starts", async () => {
    const first = fakePluginsConfigService();
    const second = fakePluginsConfigService();
    const activeAgentProfile: ActiveAgentProfileProvider = {
      getActiveAgentProfile: vi.fn()
        .mockResolvedValueOnce(availableProfile("a", "/state/first"))
        .mockResolvedValueOnce(availableProfile("b", "/state/second")),
    };
    const serviceForAgentDir = vi.fn((agentDir: string): PiPackagePluginsConfigService => agentDir === "/state/first" ? first.service : second.service);
    const service = new ActiveProfilePiPackagePluginsConfigService(activeAgentProfile, serviceForAgentDir);

    await service.list("/repo");
    await service.mutate({ action: "disable", source, scope: "global", cwd: "/repo" });

    expect(serviceForAgentDir).toHaveBeenNthCalledWith(1, "/state/first");
    expect(serviceForAgentDir).toHaveBeenNthCalledWith(2, "/state/second");
    expect(first.list).toHaveBeenCalledWith("/repo");
    expect(second.mutate).toHaveBeenCalledWith({ action: "disable", source, scope: "global", cwd: "/repo" });
  });
});

function fakePluginsConfigService() {
  const response = { packages: [], totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 }, diagnostics: [] };
  const list = vi.fn<PiPackagePluginsConfigService["list"]>(() => Promise.resolve(response));
  const mutate = vi.fn<PiPackagePluginsConfigService["mutate"]>(() => Promise.resolve(response));
  return { service: { list, mutate } satisfies PiPackagePluginsConfigService, list, mutate };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-package-plugins-"));
  temporaryDirectories.push(directory);
  return directory;
}

function availableProfile(revisionCharacter: string, dir: string) {
  return {
    status: "available" as const,
    profile: {
      schemaVersion: 1 as const,
      revision: `sha256:${revisionCharacter.repeat(64)}`,
      command: `${revisionCharacter}-agent`,
      dir,
      sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
    },
  };
}
