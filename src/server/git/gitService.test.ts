import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitStatus } from "./gitService.js";

const execFile = promisify(execFileCallback);

let workspace: string | undefined;

afterEach(async () => {
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe("gitStatus", () => {
  it("reports the latest reachable tag", async () => {
    workspace = await mkdtemp(join(tmpdir(), "pi-webui-git-status-"));
    await runGit(workspace, ["init", "--initial-branch=main"]);
    await writeFile(join(workspace, "README.md"), "first release\n");
    await runGit(workspace, ["add", "README.md"]);
    await commit(workspace, "initial release");
    await runGit(workspace, ["tag", "v1.0.0"]);

    await writeFile(join(workspace, "README.md"), "next release\n");
    await runGit(workspace, ["add", "README.md"]);
    await commit(workspace, "next release");
    await runGit(workspace, ["tag", "v1.1.0"]);

    await expect(gitStatus(workspace)).resolves.toMatchObject({
      isGitRepo: true,
      branch: "main",
      latestTag: "v1.1.0",
    });
  });
});

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

async function commit(cwd: string, message: string): Promise<void> {
  await runGit(cwd, ["-c", "user.name=PI WEBUI Test", "-c", "user.email=pi-webui@example.test", "commit", "-m", message]);
}
