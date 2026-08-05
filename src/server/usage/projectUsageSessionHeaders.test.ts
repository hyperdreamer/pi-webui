import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPiSessionDir } from "../sessions/piSessionManagerGateway";
import { ProjectUsageService } from "./projectUsageService";
import { ProjectUsageSessionHeaderSource, listProjectUsageSessionHeadersInDir } from "./projectUsageSessionHeaders";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "project-usage-headers-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("listProjectUsageSessionHeadersInDir", () => {
  it("returns header candidates and skips malformed or empty session files", async () => {
    const sessionDir = join(tempDir, "sessions");
    const validPath = join(sessionDir, "valid.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(validPath, `${JSON.stringify({ type: "session", id: "valid", cwd: "/dev/app" })}\n{invalid body`, "utf8");
    await writeFile(join(sessionDir, "malformed.jsonl"), `{invalid header\n`, "utf8");
    await writeFile(join(sessionDir, "empty.jsonl"), "", "utf8");
    await writeFile(join(sessionDir, "missing-cwd.jsonl"), `${JSON.stringify({ type: "session", id: "missing-cwd" })}\n`, "utf8");
    await writeFile(join(sessionDir, "ignored.txt"), JSON.stringify({ type: "session", id: "ignored", cwd: "/dev/app" }), "utf8");

    await expect(listProjectUsageSessionHeadersInDir(sessionDir)).resolves.toEqual([
      { sessionId: "valid", path: validPath, cwd: "/dev/app" },
    ]);
  });

  it("keeps the header-only count aligned with the report for a multi-chunk header", async () => {
    const sessionDir = join(tempDir, "long-header-sessions");
    const sessionPath = join(sessionDir, "long.jsonl");
    const projectPath = "/dev/app";
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({
      type: "session",
      id: "long",
      cwd: projectPath,
      padding: "x".repeat(3 * 4 * 1024),
    })}\n`, "utf8");

    const service = new ProjectUsageService({
      candidates: {
        listForCwd: () => Promise.resolve([]),
        listAll: () => Promise.resolve([{ id: "long", path: sessionPath, cwd: projectPath }]),
        listHeadersForCwd: () => Promise.resolve([]),
        listAllHeaders: () => listProjectUsageSessionHeadersInDir(sessionDir),
        listArchived: () => Promise.resolve([]),
      },
      cache: {
        totalsFor: () => Promise.resolve({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
        flush: () => Promise.resolve(undefined),
      },
    });
    const scope = { projectPath, liveCwds: [] };

    await expect(service.count(scope)).resolves.toBe(1);
    await expect(service.report(scope)).resolves.toMatchObject({ total: { sessionCount: 1 } });
  });
});

describe("ProjectUsageSessionHeaderSource", () => {
  it("covers default and configured stores while filtering a requested cwd", async () => {
    const agentDir = join(tempDir, "agent");
    const projectCwd = join(tempDir, "project");
    const otherCwd = join(tempDir, "other");
    const envSessionDir = join(tempDir, "configured-sessions");
    await writeSessionHeader(defaultPiSessionDir(projectCwd, agentDir), "default", projectCwd);
    await writeSessionHeader(envSessionDir, "configured-project", `${projectCwd}/.`);
    await writeSessionHeader(envSessionDir, "configured-other", otherCwd);
    const source = new ProjectUsageSessionHeaderSource({
      agentDir,
      env: { PI_WEBUI_AGENT_SESSION_DIR: envSessionDir },
      sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
    });

    await expect(source.listAll()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "default", cwd: projectCwd }),
      expect.objectContaining({ sessionId: "configured-project", cwd: projectCwd }),
      expect.objectContaining({ sessionId: "configured-other", cwd: otherCwd }),
    ]));
    await expect(source.listForCwd(projectCwd)).resolves.toEqual([
      expect.objectContaining({ sessionId: "configured-project", cwd: projectCwd }),
    ]);
  });
});

async function writeSessionHeader(dir: string, id: string, cwd: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd })}\n`, "utf8");
}
