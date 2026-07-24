import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("pi-webui-docker entrypoint", () => {
  // The entrypoint intentionally supports POSIX hosts, so Windows CI cannot execute it directly.
  const posixHostIt = it.skipIf(process.platform === "win32");

  posixHostIt("streams detached helper logs inline after scheduling runtime updates", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-webui-docker-entrypoint-"));
    try {
      const runtimeRoot = join(tempDir, "runtime");
      const binDir = join(tempDir, "bin");
      const dockerCallsPath = join(tempDir, "docker-calls.log");
      await mkdir(runtimeRoot);
      await mkdir(binDir);
      await writeFile(join(runtimeRoot, ".env"), [
        `PI_WEBUI_DOCKER_INSTALL_DIR=${runtimeRoot}`,
        "COMPOSE_PROJECT_NAME=pi-webui-test",
        "PI_WEBUI_UID=1000",
        "PI_WEBUI_GID=1000",
        "DOCKER_GID=998",
        "PI_WEBUI_IMAGE=pi-webui:test",
        "",
      ].join("\n"));

      const fakeDockerPath = join(binDir, "docker");
      await writeFile(fakeDockerPath, fakeDockerScript(dockerCallsPath));
      await chmod(fakeDockerPath, 0o755);

      const { stdout, stderr } = await execFile(join(repoRoot, "docker/pi-webui-docker"), ["update"], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          PI_WEBUI_DOCKER_RUNTIME: "1",
          PI_WEBUI_DOCKER_MODE: "runtime",
          PI_WEBUI_DOCKER_INSTALL_DIR: runtimeRoot,
          PI_WEBUI_DOCKER_CONTAINER_ID: "current-web-container",
        },
      });

      const output = `${stdout}${stderr}`;
      expect(output).toContain("Started detached PI WEBUI Docker helper: pi-webui-docker-update-");
      expect(output).toContain("Streaming detached PI WEBUI Docker helper logs inline.");
      expect(output).toContain("Reconnect with: docker logs -f pi-webui-docker-update-");
      expect(output).toContain("helper log: update in progress");
      expect(output).not.toContain("Follow progress with:");

      const dockerCalls = await readFile(dockerCallsPath, "utf8");
      expect(dockerCalls).toContain("__run-detached update");
      expect(dockerCalls).toMatch(/(?:^|\n)logs -f pi-webui-docker-update-\d{14}-\d+(?:\n|$)/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function fakeDockerScript(dockerCallsPath: string): string {
  return `#!/usr/bin/env sh
set -eu
printf '%s\\n' "$*" >> ${shellQuote(dockerCallsPath)}
case "$1" in
  ps)
    exit 0
    ;;
  run)
    printf '%s\\n' fake-helper-container-id
    ;;
  logs)
    printf '%s\\n' 'helper log: update in progress'
    ;;
  inspect)
    printf '%s\\n' 0
    ;;
  rm)
    exit 0
    ;;
  *)
    printf 'unexpected docker command: %s\\n' "$*" >&2
    exit 42
    ;;
esac
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
