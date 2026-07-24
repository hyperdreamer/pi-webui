import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const startScriptPath = join(repositoryRoot, "start.sh");

describe("start.sh", () => {
  it("starts the complete development stack through npm", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-webui-start-test-"));

    try {
      const binDirectory = join(temporaryDirectory, "bin");
      const npmArgumentsPath = join(temporaryDirectory, "npm-arguments");
      const npmPath = join(binDirectory, "npm");

      mkdirSync(binDirectory);
      writeFileSync(npmPath, "#!/usr/bin/env sh\nprintf '%s\\n' \"$@\" > \"$START_SH_TEST_NPM_ARGUMENTS\"\n");
      chmodSync(npmPath, 0o755);

      const result = spawnSync(startScriptPath, [], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          START_SH_TEST_NPM_ARGUMENTS: npmArgumentsPath,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(npmArgumentsPath, "utf8").trim().split("\n")).toEqual(["run", "dev"]);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
