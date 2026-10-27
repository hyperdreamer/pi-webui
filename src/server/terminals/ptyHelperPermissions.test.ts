import { chmodSync, fchmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePtyHelperExecutable, repairPtyHelperPermissions } from "./ptyHelperPermissions.js";

const loader = vi.hoisted((): { root: string; cache: Record<string, unknown> } => ({ root: "", cache: {} }));
vi.mock("node:module", () => ({
  createRequire: () => ({ resolve: () => `${loader.root}/package.json`, get cache() { return loader.cache; } }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fchmodSync: vi.fn(fs.fchmodSync) };
});

let directory: string;
let helper: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pty-helper-permissions-"));
  loader.root = directory;
  loader.cache = {};
  helper = join(directory, "spawn-helper");
  writeFileSync(helper, "test helper", { mode: 0o644 });
  vi.mocked(fchmodSync).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("node-pty helper permissions", () => {
  it("adds only owner execute permission and preserves the helper contents", () => {
    repairPtyHelperPermissions(helper);
    expect(statSync(helper).mode & 0o777).toBe(0o744);
    expect(readFileSync(helper, "utf8")).toBe("test helper");
    expect(fchmodSync).toHaveBeenCalledOnce();
  });

  it("leaves already executable helpers unchanged, including on repeated checks", () => {
    chmodSync(helper, 0o755);
    repairPtyHelperPermissions(helper);
    repairPtyHelperPermissions(helper);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
    expect(fchmodSync).not.toHaveBeenCalled();
  });

  it("rechecks after permissions are reset by reinstalling", () => {
    repairPtyHelperPermissions(helper);
    chmodSync(helper, 0o644);
    repairPtyHelperPermissions(helper);
    expect(statSync(helper).mode & 0o777).toBe(0o744);
    expect(fchmodSync).toHaveBeenCalledTimes(2);
  });

  it("reports the exact path and preserves the permission error without escalating", () => {
    const cause = Object.assign(new Error("read-only installation"), { code: "EROFS" });
    vi.mocked(fchmodSync).mockImplementationOnce(() => { throw cause; });
    let thrown: unknown;
    try { repairPtyHelperPermissions(helper); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toHaveProperty("cause", cause);
    expect(thrown instanceof Error ? thrown.message : "").toContain(helper);
    expect(statSync(helper).mode & 0o777).toBe(0o644);
  });

  it("does not follow a non-executable helper symlink", () => {
    const link = join(directory, "link");
    symlinkSync(helper, link);
    expect(() => { repairPtyHelperPermissions(link); }).toThrow("Cannot make node-pty spawn-helper executable");
    expect(statSync(helper).mode & 0o777).toBe(0o644);
    expect(fchmodSync).not.toHaveBeenCalled();
  });

  it("does not add execute permission to a helper with special permission bits", () => {
    chmodSync(helper, 0o4644);
    expect(() => { repairPtyHelperPermissions(helper); }).toThrow("Cannot make node-pty spawn-helper executable");
    expect(fchmodSync).not.toHaveBeenCalled();
  });

  it("reports a missing helper without creating a replacement", () => {
    const missing = join(directory, "missing");
    expect(() => { repairPtyHelperPermissions(missing); }).toThrow(missing);
    expect(fchmodSync).not.toHaveBeenCalled();
  });

  it.each(["build/Release", "build/Debug", "prebuilds/darwin-arm64", "prebuilds/darwin-x64"])("repairs only the loaded addon sibling in %s", (layout) => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const nativeDirectory = join(directory, layout);
    mkdirSync(nativeDirectory, { recursive: true });
    const loadedHelper = join(nativeDirectory, "spawn-helper");
    writeFileSync(loadedHelper, "native helper", { mode: 0o644 });
    loader.cache = { [join(nativeDirectory, "pty.node")]: {}, [`${directory}-other/pty.node`]: {} };
    ensurePtyHelperExecutable();
    expect(statSync(loadedHelper).mode & 0o777).toBe(0o744);
    expect(statSync(helper).mode & 0o777).toBe(0o644);
  });

  it("does not guess when no addon or multiple addons are loaded", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    ensurePtyHelperExecutable();
    loader.cache = { [join(directory, "pty.node")]: {}, [join(directory, "other", "pty.node")]: {} };
    ensurePtyHelperExecutable();
    expect(fchmodSync).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"])("does not inspect or repair helpers on %s", (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    ensurePtyHelperExecutable();
    expect(fchmodSync).not.toHaveBeenCalled();
  });
});
