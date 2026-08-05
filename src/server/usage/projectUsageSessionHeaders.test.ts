import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPiSessionDir } from "../sessions/piSessionManagerGateway";
import { ProjectUsageService } from "./projectUsageService";
import { ProjectUsageSessionHeaderSource, listProjectUsageSessionHeadersInDir } from "./projectUsageSessionHeaders";
import { scanSessionUsage } from "./sessionUsageScanner";

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
  it("keeps count and report on the same header-only candidates with one content stream", async () => {
    const sessionDir = join(tempDir, "wired-session-store");
    const projectPath = join(tempDir, "project");
    const retiredCwd = join(projectPath, ".worktrees", "retired");
    const archivePath = join(tempDir, "archive", "archived.jsonl");
    await writeUsageSession(sessionDir, "live", projectPath, 1);
    await writeUsageSession(sessionDir, "retired", retiredCwd, 2);
    await writeUsageSession(sessionDir, "other", join(tempDir, "other"), 4);
    await writeUsageSession(join(tempDir, "archive"), "archived", projectPath, 8);

    const headers = new ProjectUsageSessionHeaderSource({
      agentDir: join(tempDir, "agent"),
      env: { PI_WEBUI_AGENT_SESSION_DIR: sessionDir },
      sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
    });
    const fullEntryGateway = {
      listForCwd: vi.fn(() => Promise.reject(new Error("full cwd listing must not run"))),
      listAll: vi.fn(() => Promise.reject(new Error("full history listing must not run"))),
    };
    const allHeaderCandidateIds: string[][] = [];
    const candidates = {
      ...fullEntryGateway,
      listHeadersForCwd: (cwd: string) => headers.listForCwd(cwd),
      listAllHeaders: async () => {
        const listed = await headers.listAll();
        allHeaderCandidateIds.push(listed.map((candidate) => candidate.sessionId));
        return listed;
      },
      listArchived: () => Promise.resolve([{ sessionId: "archived", cwd: projectPath, archivePath }]),
    };
    let openContentStreams = 0;
    let maxOpenContentStreams = 0;
    const scannedCandidateIds: string[] = [];
    const service = new ProjectUsageService({
      candidates,
      cache: {
        totalsFor: async (sessionId, path) => {
          openContentStreams += 1;
          maxOpenContentStreams = Math.max(maxOpenContentStreams, openContentStreams);
          scannedCandidateIds.push(sessionId);
          try {
            return (await scanSessionUsage(path, 0)).totals;
          } finally {
            openContentStreams -= 1;
          }
        },
        flush: () => Promise.resolve(undefined),
      },
    });
    const scope = { projectPath, liveCwds: [projectPath] };

    const count = await service.count(scope);
    const report = await service.report(scope);

    expect(fullEntryGateway.listForCwd).not.toHaveBeenCalled();
    expect(fullEntryGateway.listAll).not.toHaveBeenCalled();
    expect(allHeaderCandidateIds).toHaveLength(2);
    expect(allHeaderCandidateIds[1]).toEqual(allHeaderCandidateIds[0]);
    expect(scannedCandidateIds).toEqual(["archived", "live", "retired"]);
    expect(maxOpenContentStreams).toBe(1);
    expect(report.total.sessionCount).toBe(count);
    expect(report.buckets.live.sessionCount).toBe(1);
    expect(report.buckets.retired.sessionCount).toBe(1);
    expect(report.buckets.archived.sessionCount).toBe(1);
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

async function writeUsageSession(dir: string, id: string, cwd: string, input: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), `${[
    JSON.stringify({ type: "session", id, cwd }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: input / 100 } },
      },
    }),
  ].join("\n")}\n`, "utf8");
}

async function writeSessionHeader(dir: string, id: string, cwd: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd })}\n`, "utf8");
}
