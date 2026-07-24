import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkNodePtyDarwinSpawnHelper, formatNodePtyDarwinSpawnHelperCheck, PI_WEBUI_SPAWN_HELPER_ISSUE_URL } from "./nodePtySpawnHelper.js";

const allowAccess = (): void => undefined;

describe("node-pty macOS spawn-helper diagnostics", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("skips the check outside macOS", () => {
    const check = checkNodePtyDarwinSpawnHelper({ platform: "linux" });

    expect(check).toEqual({ status: "skipped", reason: "not-macos" });
    expect(formatNodePtyDarwinSpawnHelperCheck(check)).toEqual({ ok: true, lines: [] });
  });

  it("reports a proposed chmod workaround for non-executable helpers", async () => {
    const fixture = await createNodePtyFixture();

    const check = checkNodePtyDarwinSpawnHelper({
      platform: "darwin",
      arch: "arm64",
      nodePtyPackageJsonPath: fixture.packageJsonPath,
      access: () => { throw new Error("not executable"); },
    });

    expect(check).toMatchObject({
      status: "spawn-helper-not-executable",
      helperPath: fixture.helperPath,
      nodePtyRoot: fixture.root,
      fixCommand: `chmod +x '${fixture.helperPath}'`,
    });

    const formatted = formatNodePtyDarwinSpawnHelperCheck(check);
    expect(formatted.ok).toBe(false);
    expect(formatted.lines).toContain(`  PI WEBUI tracking issue: ${PI_WEBUI_SPAWN_HELPER_ISSUE_URL}`);
    expect(formatted.lines).toContain(`    chmod +x '${fixture.helperPath}'`);
    expect(formatted.lines).toContain("  Then run `pi-webui doctor` again and retry opening a terminal.");
    expect(formatted.lines.join("\n")).not.toContain("restart");
  });

  it("passes when the selected helper is executable", async () => {
    const fixture = await createNodePtyFixture();

    const check = checkNodePtyDarwinSpawnHelper({
      platform: "darwin",
      arch: "arm64",
      nodePtyPackageJsonPath: fixture.packageJsonPath,
      access: allowAccess,
    });

    expect(check).toMatchObject({ status: "ok", helperPath: fixture.helperPath, nodePtyRoot: fixture.root });
    expect(formatNodePtyDarwinSpawnHelperCheck(check)).toEqual({
      ok: true,
      lines: ["✓ node-pty macOS spawn-helper executable", `  ${fixture.helperPath}`],
    });
  });

  it("checks the helper next to node-pty's selected native module", async () => {
    const fixture = await createNodePtyFixture();
    const buildDir = join(fixture.root, "build", "Release");
    await mkdir(buildDir, { recursive: true });
    await writeFile(join(buildDir, "pty.node"), "");
    const buildHelperPath = join(buildDir, "spawn-helper");
    await writeFile(buildHelperPath, "");

    const check = checkNodePtyDarwinSpawnHelper({
      platform: "darwin",
      arch: "arm64",
      nodePtyPackageJsonPath: fixture.packageJsonPath,
      access: allowAccess,
    });

    expect(check).toMatchObject({ status: "ok", helperPath: buildHelperPath });
  });

  async function createNodePtyFixture(): Promise<{ root: string; packageJsonPath: string; helperPath: string }> {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-node-pty-"));
    tempRoots.push(root);

    const packageJsonPath = join(root, "package.json");
    const prebuildDir = join(root, "prebuilds", "darwin-arm64");
    await mkdir(prebuildDir, { recursive: true });
    await writeFile(packageJsonPath, "{}");
    await writeFile(join(prebuildDir, "pty.node"), "");

    const helperPath = join(prebuildDir, "spawn-helper");
    await writeFile(helperPath, "");

    return { root, packageJsonPath, helperPath };
  }
});
