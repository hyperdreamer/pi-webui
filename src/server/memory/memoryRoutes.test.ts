import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerMemoryRoutes } from "./memoryRoutes.js";
import type { ActiveAgentProfileProvider } from "../activeAgentProfileProvider.js";
import type { SessionDaemonAgentProfileResult } from "../../sessiond/sessionDaemonClient.js";
import type { MemoryEntriesResponse } from "../../shared/apiTypes.js";

function fakeProfileProvider(dir: string): ActiveAgentProfileProvider {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    getActiveAgentProfile: async (): Promise<SessionDaemonAgentProfileResult> => ({
      status: "available",
      profile: {
        schemaVersion: 1 as const,
        revision: "test-revision",
        command: "pi",
        dir,
        sessionDirEnvKeys: [],
      },
    }),
  };
}

function unavailableProvider(): ActiveAgentProfileProvider {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    getActiveAgentProfile: async (): Promise<SessionDaemonAgentProfileResult> => ({
      status: "unavailable",
      error: "no agent profile",
    }),
  };
}

describe("memoryRoutes", () => {
  let app: FastifyInstance;
  let agentDir: string;
  let provider: ActiveAgentProfileProvider;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-webui-memory-routes-"));
    provider = fakeProfileProvider(agentDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(agentDir, { recursive: true, force: true });
  });

  async function writeMemoryFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(agentDir, relativePath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async function buildApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    registerMemoryRoutes(instance, provider, "/api");
    return instance;
  }

  describe("GET /api/agent-memory/global", () => {
    it("returns empty entries when no memory files exist", async () => {
      app = await buildApp();
      const response = await app.inject({ method: "GET", url: "/api/agent-memory/global" });
      expect(response.statusCode).toBe(200);
      const body: MemoryEntriesResponse = response.json();
      expect(body.entries).toEqual([]);
    });

    it("returns entries from MEMORY.md and failures.md", async () => {
      await writeMemoryFile("pi-hermes-memory/MEMORY.md", "Entry A.");
      await writeMemoryFile("pi-hermes-memory/failures.md", "[tool-quirk] Entry B.");
      app = await buildApp();
      const response = await app.inject({ method: "GET", url: "/api/agent-memory/global" });
      expect(response.statusCode).toBe(200);
      const body: MemoryEntriesResponse = response.json();
      expect(body.entries).toHaveLength(2);
    });

    it("returns 503 when agent profile is unavailable", async () => {
      provider = unavailableProvider();
      app = await buildApp();
      const response = await app.inject({ method: "GET", url: "/api/agent-memory/global" });
      expect(response.statusCode).toBe(503);
    });
  });

  describe("GET /api/agent-memory/project", () => {
    it("returns 400 when projectPath query is missing", async () => {
      app = await buildApp();
      const response = await app.inject({ method: "GET", url: "/api/agent-memory/project" });
      expect(response.statusCode).toBe(400);
    });

    it("returns empty entries when project memory file does not exist", async () => {
      app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-memory/project?projectPath=%2Fhome%2Fnonexistent",
      });
      expect(response.statusCode).toBe(200);
      const body: MemoryEntriesResponse = response.json();
      expect(body.entries).toEqual([]);
    });

    it("returns entries from a project MEMORY.md", async () => {
      await writeMemoryFile("projects-memory/my-project/MEMORY.md", "Project entry.");
      app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-memory/project?projectPath=%2Fhome%2Fuser%2Fmy-project",
      });
      expect(response.statusCode).toBe(200);
      const body: MemoryEntriesResponse = response.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]?.content).toBe("Project entry.");
    });

    it("returns 503 when agent profile is unavailable", async () => {
      provider = unavailableProvider();
      app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-memory/project?projectPath=%2Fsome%2Fpath",
      });
      expect(response.statusCode).toBe(503);
    });
  });
});
