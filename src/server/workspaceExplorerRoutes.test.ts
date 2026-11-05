import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import http from "node:http";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebUiConfigResponse, PiWebUiConfigValues } from "../shared/apiTypes.js";
import type { Project, Workspace } from "./types.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { openWorkspaceFileView, type WorkspaceFileView, type WorkspaceFileViewOpener } from "./workspaces/fileViewService.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { registerWorkspaceExplorerRoutes, type WorkspaceExplorerRouteOptions } from "./workspaceExplorerRoutes.js";

const aliases = ["/api", "/api/machines/local"] as const;

const documentPolicy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'";

const denied = "PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access.";

// Independent fixture bytes: the same local content the file-view service tests
// use, so a response assertion compares against literal expected data instead of
// a value imported from production.
const supportedFiles = [
  ["HTML", "a.html", "<p>hello</p>", "text/html; charset=utf-8", true],
  ["SVG", "a.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml", true],
  ["PDF", "a.pdf", "%PDF-1.7\n", "application/pdf", false],
  ["PNG", "a.png", Buffer.from([137, 80, 78, 71]), "image/png", false],
  ["text", "a.txt", "café\n", "text/plain; charset=utf-8", false],
] as const;

const fileErrors = [
  ["missing path", "", 400, "path query parameter is required"],
  ["empty path", "?path=", 400, "path query parameter is required"],
  ["repeated path", "?path=a.html&path=b.html", 400, "path query parameter must be a single string"],
  ["NUL", "?path=a%00.html", 400, "path query parameter must not contain NUL bytes"],
  ["traversal", "?path=..%2Fsecret.html", 403, "PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access."],
  ["missing target", "?path=missing.html", 404, "File not found: missing.html"],
  ["too large", "?path=huge.html", 413, "File is too large to preview (limit 64 MB)."],
  ["directory", "?path=directory.html", 415, "This file type cannot be previewed in PI WEBUI."],
  ["unsupported", "?path=a.exe", 415, "This file type cannot be previewed in PI WEBUI."],
] as const;

interface ConfigReadState {
  value: PiWebUiConfigValues;
  error: Error | undefined;
  reads: number;
}

interface HeldPhase {
  entered: Deferred<undefined>;
  gate: Deferred<undefined>;
}

interface ExplorerFixtureOptions {
  openFileView?: WorkspaceFileViewOpener;
  onRequest?: (reply: FastifyReply) => void;
  requireProjectError?: Error;
  holdContext?: HeldPhase;
  holdConfig?: HeldPhase;
}

interface ExplorerFixture {
  app: FastifyInstance;
  project: Project;
  workspace: Workspace;
  root: string;
  tempDir: string;
  outsideFile: string;
  config: ConfigReadState;
  logs: string[];
  nextViewSettlement(): Promise<void>;
  close(): Promise<void>;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace explorer file view route", () => {
  for (const alias of aliases) {
    for (const [label, name, bytes, type, isDocument] of supportedFiles) {
      it(`serves ${label} through ${alias}`, async () => {
        const fixture = await explorerFixture();
        try {
          const response = await fixture.app.inject({ url: viewPath(fixture, name, alias) });

          expect(response.statusCode).toBe(200);
          expect(response.rawPayload).toEqual(Buffer.from(bytes));
          expect(response.headers["content-type"]).toBe(type);
          successHeaders(response);
          if (isDocument) expect(response.headers["content-security-policy"]).toBe(documentPolicy);
          else expect(response.headers["content-security-policy"]).toBeUndefined();
        } finally {
          await fixture.close();
        }
      });
    }

    for (const [name, query, status, body] of fileErrors) {
      it(`returns ${name} as an exact plain-text page through ${alias}`, async () => {
        const fixture = await explorerFixture();
        try {
          const response = await fixture.app.inject({
            url: `${alias}/projects/${fixture.project.id}/workspaces/${encodeURIComponent(fixture.workspace.id)}/file/view${query}`,
          });

          expect(response.statusCode).toBe(status);
          expect(response.body).toBe(body);
          errorHeaders(response);
        } finally {
          await fixture.close();
        }
      });
    }

    it(`returns a forbidden absolute root as an exact plain-text page through ${alias}`, async () => {
      const fixture = await explorerFixture();
      try {
        const query = new URLSearchParams({ path: fixture.outsideFile }).toString();
        const response = await fixture.app.inject({
          url: `${alias}/projects/${fixture.project.id}/workspaces/${encodeURIComponent(fixture.workspace.id)}/file/view?${query}`,
        });

        expect(response.statusCode).toBe(403);
        expect(response.body).toBe(denied);
        errorHeaders(response);
      } finally {
        await fixture.close();
      }
    });
  }

  it("distinguishes unknown project workspace and infrastructure failures", async () => {
    const fixture = await explorerFixture();
    try {
      const unknownProject = await fixture.app.inject({ url: viewPath(fixture, "a.html", "/api", "missing-project") });
      const unknownWorkspace = await fixture.app.inject({ url: viewPath(fixture, "a.html", "/api", undefined, "missing-workspace") });

      expect(unknownProject.statusCode).toBe(404);
      expect(unknownProject.body).toBe("Project not found");
      errorHeaders(unknownProject);
      expect(unknownWorkspace.statusCode).toBe(404);
      expect(unknownWorkspace.body).toBe("Workspace not found");
      errorHeaders(unknownWorkspace);
      expect(fixture.logs.join("\n")).not.toContain("Project not found");

      fixture.config.error = new Error("config load failed");
      const configFailure = await fixture.app.inject({ url: viewPath(fixture, "a.html") });

      expect(configFailure.statusCode).toBe(500);
      expect(configFailure.body).toBe("Unable to preview this file.");
      errorHeaders(configFailure);
      expect(fixture.logs.join("\n")).toContain("config load failed");
    } finally {
      await fixture.close();
    }

    const storeFailureFixture = await explorerFixture({ requireProjectError: new Error("project store failed") });
    try {
      const storeFailure = await storeFailureFixture.app.inject({
        url: `/api/projects/${storeFailureFixture.project.id}/workspaces/${encodeURIComponent(storeFailureFixture.workspace.id)}/file/view?path=a.html`,
      });

      expect(storeFailure.statusCode).toBe(500);
      expect(storeFailure.body).toBe("Unable to preview this file.");
      errorHeaders(storeFailure);
      expect(storeFailureFixture.logs.join("\n")).toContain("project store failed");
    } finally {
      await storeFailureFixture.close();
    }
  });

  it("passes hosting-machine effective global and project roots to the opener", async () => {
    const opened = vi.fn<WorkspaceFileViewOpener>(async (rootPath, path, pathAccess) => openWorkspaceFileView(rootPath, path, pathAccess));
    const fixture = await explorerFixture({ openFileView: opened });
    const globalAllowed = join(fixture.tempDir, "global-allowed");
    const projectAllowed = join(fixture.tempDir, "project-allowed");
    const unrelated = join(fixture.tempDir, "unrelated");
    const globalFile = join(globalAllowed, "global.html");
    const projectFile = join(projectAllowed, "project.html");
    const unrelatedFile = join(unrelated, "secret.html");
    try {
      await Promise.all([mkdir(globalAllowed), mkdir(projectAllowed), mkdir(unrelated)]);
      await Promise.all([
        writeFile(globalFile, "<p>global</p>"),
        writeFile(projectFile, "<p>project</p>"),
        writeFile(unrelatedFile, "<p>unrelated</p>"),
      ]);
      await mkdir(join(fixture.root, ".pi-webui"));
      await writeFile(
        join(fixture.root, ".pi-webui", "config.json"),
        JSON.stringify({ version: 1, pathAccess: { allowedPaths: [projectAllowed] } }),
      );
      // The hosting machine's global config read is the mutable, typed provider.
      fixture.config.value = { pathAccess: { allowedPaths: [globalAllowed] } };

      const projectRead = await fixture.app.inject({ url: viewPath(fixture, projectFile) });
      const globalRead = await fixture.app.inject({ url: viewPath(fixture, globalFile) });
      const deniedRead = await fixture.app.inject({ url: viewPath(fixture, unrelatedFile) });

      expect(projectRead.statusCode).toBe(200);
      expect(projectRead.body).toBe("<p>project</p>");
      expect(globalRead.statusCode).toBe(200);
      expect(globalRead.body).toBe("<p>global</p>");
      expect(deniedRead.statusCode).toBe(403);
      expect(deniedRead.body).toBe(denied);
      expect(opened).toHaveBeenCalledTimes(3);
      for (const call of opened.mock.calls) {
        expect(call[0]).toBe(fixture.root);
        expect(call[2]).toEqual({ allowedPaths: [globalAllowed, projectAllowed] });
      }
      expect(opened.mock.calls.map((call) => call[1])).toEqual([projectFile, globalFile, unrelatedFile]);
    } finally {
      await fixture.close();
    }
  });

  it("does not decode the path a second time", async () => {
    const opened = vi.fn<WorkspaceFileViewOpener>(async (rootPath, path, pathAccess) => openWorkspaceFileView(rootPath, path, pathAccess));
    const fixture = await explorerFixture({ openFileView: opened });
    try {
      await writeFile(join(fixture.root, "a%20.html"), "<p>percent</p>");
      const query = new URLSearchParams({ path: "a%20.html" }).toString();
      expect(query).toBe("path=a%2520.html");

      const response = await fixture.app.inject({
        url: `/api/projects/${fixture.project.id}/workspaces/${encodeURIComponent(fixture.workspace.id)}/file/view?${query}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("<p>percent</p>");
      expect(opened).toHaveBeenCalledWith(fixture.root, "a%20.html", undefined);
    } finally {
      await fixture.close();
    }
  });

  it("returns a whole 200 body for a Range request", async () => {
    const fixture = await explorerFixture();
    try {
      const response = await fixture.app.inject({ url: viewPath(fixture, "a.html"), headers: { range: "bytes=0-1" } });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("<p>hello</p>");
      expect(response.headers["content-range"]).toBeUndefined();
      expect(response.headers["accept-ranges"]).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("keeps default HEAD handling bodyless and closes the created stream", async () => {
    const views: WorkspaceFileView[] = [];
    const opened = vi.fn<WorkspaceFileViewOpener>(async (rootPath, path, pathAccess) => {
      const view = await openWorkspaceFileView(rootPath, path, pathAccess);
      views.push(view);
      return view;
    });
    const fixture = await explorerFixture({ openFileView: opened });
    const url = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const head = await requestHttp(`${url}${viewPath(fixture, "a.html")}`, "HEAD");
      expect(head.status).toBe(200);
      expect(head.body).toEqual(Buffer.alloc(0));
      expect(head.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(views).toHaveLength(1);
      await vi.waitFor(() => { expect(views[0]?.stream.closed).toBe(true); });

      const get = await requestHttp(`${url}${viewPath(fixture, "a.html")}`, "GET");
      expect(get.status).toBe(200);
      expect(get.body.toString()).toBe("<p>hello</p>");
    } finally {
      await fixture.close();
    }
  });

  it("releases a stream returned after the reply disconnects during open", async () => {
    const entered = deferred<undefined>();
    const handoff = deferred<WorkspaceFileView>();
    const opened = vi.fn<WorkspaceFileViewOpener>(() => {
      entered.resolve(undefined);
      return handoff.promise;
    });
    const disconnected = deferred<undefined>();
    const fixture = await explorerFixture({
      openFileView: opened,
      onRequest: (reply) => {
        reply.raw.once("close", () => { disconnected.resolve(undefined); });
      },
    });
    const url = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const view = await openWorkspaceFileView(fixture.root, "a.html");
    const observation = observeGet(`${url}${viewPath(fixture, "a.html")}`);
    try {
      await entered.promise;
      observation.destroy();
      await disconnected.promise;
      handoff.resolve(view);

      await vi.waitFor(() => { expect(view.stream.closed).toBe(true); }, { timeout: 3_000 });
      const result = await observation.result;
      expect(result.ended).toBe(false);
      expect(result.status).toBe(0);
    } finally {
      handoff.resolve(view);
      await fixture.close();
    }
  });

  for (const alias of aliases) {
    it(`stops after a disconnect during context resolution through ${alias}`, async () => {
      const held = heldPhase();
      const opened = vi.fn<WorkspaceFileViewOpener>();
      const disconnected = deferred<undefined>();
      const fixture = await explorerFixture({
        openFileView: opened,
        holdContext: held,
        onRequest: (reply) => { reply.raw.once("close", () => { disconnected.resolve(undefined); }); },
      });
      const url = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
      const settled = fixture.nextViewSettlement();
      const observation = observeGet(`${url}${viewPath(fixture, "a.html", alias)}`);
      try {
        await held.entered.promise;
        observation.destroy();
        await disconnected.promise;
        held.gate.resolve(undefined);
        await settled;

        expect(fixture.config.reads).toBe(0);
        expect(opened).not.toHaveBeenCalled();
        const result = await observation.result;
        expect(result.status).toBe(0);
        expect(result.ended).toBe(false);
      } finally {
        held.gate.resolve(undefined);
        await fixture.close();
      }
    });

    it(`stops after a disconnect during config resolution through ${alias}`, async () => {
      const held = heldPhase();
      const opened = vi.fn<WorkspaceFileViewOpener>();
      const disconnected = deferred<undefined>();
      const fixture = await explorerFixture({
        openFileView: opened,
        holdConfig: held,
        onRequest: (reply) => { reply.raw.once("close", () => { disconnected.resolve(undefined); }); },
      });
      const url = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
      const settled = fixture.nextViewSettlement();
      const observation = observeGet(`${url}${viewPath(fixture, "a.html", alias)}`);
      try {
        await held.entered.promise;
        observation.destroy();
        await disconnected.promise;
        held.gate.resolve(undefined);
        await settled;

        expect(fixture.config.reads).toBe(1);
        expect(opened).not.toHaveBeenCalled();
        const result = await observation.result;
        expect(result.status).toBe(0);
        expect(result.ended).toBe(false);
      } finally {
        held.gate.resolve(undefined);
        await fixture.close();
      }
    });
  }

  it("keeps validation failures free of workspace and opener work", async () => {
    const opened = vi.fn<WorkspaceFileViewOpener>();
    const fixture = await explorerFixture({ openFileView: opened });
    try {
      const rows = [
        ["", "path query parameter is required"],
        ["?path=", "path query parameter is required"],
        ["?path=a.html&path=b.html", "path query parameter must be a single string"],
        ["?path=a%00.html", "path query parameter must not contain NUL bytes"],
      ] as const;
      for (const [query, body] of rows) {
        const response = await fixture.app.inject({ url: `/api/projects/missing-project/workspaces/missing-workspace/file/view${query}` });

        expect(response.statusCode).toBe(400);
        expect(response.body).toBe(body);
        errorHeaders(response);
      }
      expect(opened).not.toHaveBeenCalled();
      expect(fixture.config.reads).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});

class ThrowingProjectService extends ProjectService {
  constructor(private readonly failure: Error) {
    super(new ProjectStore("/dev/null"));
  }

  override requireProject(): Promise<Project> {
    return Promise.reject(this.failure);
  }
}

class HeldProjectService extends ProjectService {
  constructor(private readonly delegate: ProjectService, private readonly hold: HeldPhase) {
    super(new ProjectStore("/dev/null"));
  }

  override async requireProject(id: string): Promise<Project> {
    this.hold.entered.resolve(undefined);
    await this.hold.gate.promise;
    return this.delegate.requireProject(id);
  }
}

async function explorerFixture(options: ExplorerFixtureOptions = {}): Promise<ExplorerFixture> {
  const tempDir = await realpath(await mkdtemp(join(tmpdir(), "workspace-explorer-view-")));
  tempDirs.push(tempDir);
  const root = join(tempDir, "project");
  const outside = join(tempDir, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  for (const [, name, bytes] of supportedFiles) await writeFile(join(root, name), bytes);
  await mkdir(join(root, "directory.html"));
  await writeFile(join(root, "a.exe"), "unknown");
  const huge = await open(join(root, "huge.html"), "w");
  try {
    await huge.truncate(67_108_865);
  } finally {
    await huge.close();
  }
  const outsideFile = join(outside, "secret.html");
  await writeFile(outsideFile, "<p>secret</p>");

  const baseProjects = new ProjectService(new ProjectStore(join(tempDir, "projects.json")));
  const workspaces = new WorkspaceService();
  const project = await baseProjects.add({ path: root });
  const workspace = (await workspaces.list(project))[0];
  if (workspace === undefined) throw new Error("Fixture project has no workspace");
  const projects = options.requireProjectError !== undefined
    ? new ThrowingProjectService(options.requireProjectError)
    : options.holdContext !== undefined
      ? new HeldProjectService(baseProjects, options.holdContext)
      : baseProjects;

  const config: ConfigReadState = { value: {}, error: undefined, reads: 0 };
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      level: "error",
      stream: { write: (line: string) => { logs.push(line); } },
    },
  });
  if (options.onRequest !== undefined) {
    const onRequest = options.onRequest;
    app.addHook("onRequest", async (_request, reply) => { onRequest(reply); });
  }
  const viewSettlements: Deferred<undefined>[] = [];
  app.addHook("onRoute", (route) => {
    if (typeof route.url !== "string" || !route.url.endsWith("/file/view")) return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      try {
        return await handler.call(this, request, reply);
      } finally {
        viewSettlements.shift()?.resolve(undefined);
      }
    };
  });
  const routeOptions: WorkspaceExplorerRouteOptions = {
    config: {
      read: async () => {
        config.reads += 1;
        if (options.holdConfig !== undefined) {
          options.holdConfig.entered.resolve(undefined);
          await options.holdConfig.gate.promise;
        }
        if (config.error !== undefined) throw config.error;
        return configResponse(config.value);
      },
    },
    ...(options.openFileView === undefined ? {} : { openFileView: options.openFileView }),
  };
  registerWorkspaceExplorerRoutes(app, projects, workspaces, "/api", routeOptions);
  registerWorkspaceExplorerRoutes(app, projects, workspaces, "/api/machines/local", routeOptions);

  return {
    app,
    project,
    workspace,
    root,
    tempDir,
    outsideFile,
    config,
    logs,
    nextViewSettlement: () => {
      const settlement = deferred<undefined>();
      viewSettlements.push(settlement);
      return settlement.promise;
    },
    close: () => app.close(),
  };
}

function configResponse(value: PiWebUiConfigValues): PiWebUiConfigResponse {
  return {
    path: "/tmp/pi-webui-config.json",
    exists: false,
    config: value,
    effectiveConfig: value,
    envOverrides: {
      host: false,
      port: false,
      allowedHosts: false,
      spawnSessions: false,
      subsessions: false,
      agentCommand: false,
      agentDir: false,
      agentSessionDir: false,
      sessiondUrl: false,
    },
  };
}

function viewPath(fixture: Pick<ExplorerFixture, "project" | "workspace">, path: string, alias = "/api", projectId = fixture.project.id, workspaceId = fixture.workspace.id): string {
  const query = new URLSearchParams({ path }).toString();
  return `${alias}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file/view?${query}`;
}

function successHeaders(response: { headers: Record<string, unknown> }): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  for (const key of ["content-length", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified"]) {
    expect(response.headers[key]).toBeUndefined();
  }
}

function errorHeaders(response: { headers: Record<string, unknown> }): void {
  expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  for (const key of ["content-security-policy", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified"]) {
    expect(response.headers[key]).toBeUndefined();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function heldPhase(): HeldPhase {
  return { entered: deferred<undefined>(), gate: deferred<undefined>() };
}

interface ObservedResponse {
  ended: boolean;
  aborted: boolean;
  bytes: Buffer;
  headers: http.IncomingHttpHeaders;
  status: number;
}

function observeGet(url: string) {
  let request: http.ClientRequest | undefined;
  const result = new Promise<ObservedResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let response: http.IncomingMessage | undefined;
    const finish = (ended: boolean, aborted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ended, aborted, bytes: Buffer.concat(chunks), headers: response?.headers ?? {}, status: response?.statusCode ?? 0 });
    };
    const deadline = setTimeout(() => {
      request?.destroy();
      reject(new Error("HTTP observation deadline"));
    }, 3_000);
    request = http.get(url, (incoming) => {
      response = incoming;
      incoming.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      incoming.once("end", () => { finish(true, false); });
      incoming.once("aborted", () => { finish(false, true); });
      incoming.once("error", () => { finish(false, true); });
    });
    request.on("error", () => { finish(false, true); });
  });
  return { result, destroy: () => { request?.destroy(); } };
}

function requestHttp(url: string, method: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { reject(new Error("HTTP request deadline")); }, 3_000);
    const request = http.request(url, { method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      response.once("end", () => {
        clearTimeout(deadline);
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
      response.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });
    request.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.end();
  });
}
