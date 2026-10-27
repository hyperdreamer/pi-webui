import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("rejects a non-executable FIFO without blocking the daemon thread", () => {
  const directory = mkdtempSync(join(tmpdir(), "pty-helper-fifo-"));
  const helper = join(directory, "spawn-helper");
  try {
    execFileSync("mkfifo", ["-m", "644", helper]);
    // Exercise real filesystem behavior outside the test worker: the old openSync
    // blocks before fstat, so an external timeout must bound this regression.
    const result = spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval",
      `import { repairPtyHelperPermissions } from ${JSON.stringify(new URL("./ptyHelperPermissions.ts", import.meta.url).href)};
       try {
         repairPtyHelperPermissions(${JSON.stringify(helper)});
         process.exitCode = 1;
       } catch (error) {
         console.log(error.message);
         console.log(error.cause?.message);
       }`,
    ], { encoding: "utf8", timeout: 3_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(helper);
    expect(result.stdout).toContain("spawn-helper is not a regular file");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
