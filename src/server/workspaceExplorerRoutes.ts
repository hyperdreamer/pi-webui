import type { FastifyInstance, FastifyReply } from "fastify";
import type { WriteWorkspaceFileOptions } from "../shared/apiTypes.js";
import type { PiWebUiConfigService } from "./configRoutes.js";
import { FileViewError, openWorkspaceFileView, type WorkspaceFileViewOpener } from "./workspaces/fileViewService.js";
import { ProjectNotFoundError, type ProjectService } from "./projects/projectService.js";
import { createReplyDisconnectScope } from "./http/replyDisconnect.js";
import { sendWorkspaceFileView } from "./http/fileViewReply.js";
import { deleteWorkspaceFile, moveWorkspaceFile, readWorkspaceFile, resolveWorkspaceFileMutationPath, writeWorkspaceFile } from "./workspaces/fileContentService.js";
import { isAbsoluteishFileSuggestionQuery, listFileSuggestions, listPathSuggestions } from "./workspaces/fileSuggestions.js";
import { listWorkspaceTree } from "./workspaces/fileTreeService.js";
import { readWorkspaceImagePreview } from "./workspaces/imagePreviewService.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";
import { pathAccessForWorkspaceContext } from "./workspaces/effectivePathAccess.js";
import type { WorkspaceService } from "./workspaces/workspaceService.js";
import type { WorkspaceTasksWorkspacePathGate } from "./workspaceTasks/workspaceTasksWorkspacePathGate.js";
import {
  WorkspaceTasksMoveConflictError,
  WorkspaceTasksMoveInProgressError,
  WorkspaceTasksMoveRecoveryPendingError,
} from "./workspaceTasks/workspaceTasksMoveRegistry.js";
import { isWorkspaceTasksPath, type WorkspaceTasksNormalizedFileMove, type WorkspaceTasksWorkspaceFileResolver } from "./workspaceTasks/workspaceTasksWorkspaceFile.js";

export interface WorkspaceExplorerRouteOptions {
  config?: Pick<PiWebUiConfigService, "read">;
  taskPathGate?: WorkspaceTasksWorkspacePathGate;
  taskFiles?: WorkspaceTasksWorkspaceFileResolver;
  openFileView?: WorkspaceFileViewOpener;
}

export function registerWorkspaceExplorerRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, prefix = "/api", options: WorkspaceExplorerRouteOptions = {}): void {
  registerWorkspaceFileContentParsers(app);

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/tree`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await listWorkspaceTree(context.root, request.query.path, await pathAccessForWorkspaceContext(context, options.config));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await readWorkspaceFile(context.root, request.query.path, await pathAccessForWorkspaceContext(context, options.config));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { projectId: string; workspaceId: string }; Body: Buffer; Querystring: { path?: string; createDirs?: string; overwrite?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const writeOptions: WriteWorkspaceFileOptions = {
        createDirs: request.query.createDirs !== "false",
        overwrite: request.query.overwrite !== "false",
      };
      const mutationPath = await resolveWorkspaceFileMutationPath(context.root, request.query.path, {
        stopAt: isWorkspaceTasksPath,
        followFinalSymlink: true,
      });
      const taskFiles = options.taskFiles;
      const taskPath = taskFiles === undefined ? undefined : mutationPath.resolvedPaths.find(isWorkspaceTasksPath);
      if (taskFiles !== undefined && taskPath !== undefined) {
        const operation = () => taskFiles.writeExplorerTaskFile(
          { projectId: request.params.projectId, workspaceId: request.params.workspaceId },
          request.body,
          writeOptions,
        );
        if (options.taskPathGate !== undefined) {
          return await options.taskPathGate.run(
            { projectId: request.params.projectId, workspaceId: request.params.workspaceId },
            [taskPath],
            operation,
          );
        }
        return await operation();
      }
      return await writeWorkspaceFile(context.root, request.query.path, request.body, writeOptions);
    } catch (error) {
      return sendWorkspaceExplorerError(reply, error);
    }
  });

  app.delete<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const mutationPath = await resolveWorkspaceFileMutationPath(context.root, request.query.path, {
        stopAt: isWorkspaceTasksPath,
        followFinalSymlink: false,
      });
      const taskFiles = options.taskFiles;
      const taskPath = taskFiles === undefined ? undefined : mutationPath.resolvedPaths.find(isWorkspaceTasksPath);
      if (taskFiles !== undefined && taskPath !== undefined) {
        const operation = () => taskFiles.deleteExplorerTaskFile(
          { projectId: request.params.projectId, workspaceId: request.params.workspaceId },
        );
        if (options.taskPathGate !== undefined) {
          return await options.taskPathGate.run(
            { projectId: request.params.projectId, workspaceId: request.params.workspaceId },
            [taskPath],
            operation,
          );
        }
        return await operation();
      }
      return await deleteWorkspaceFile(context.root, request.query.path);
    } catch (error) {
      return sendWorkspaceExplorerError(reply, error);
    }
  });

  app.post<{ Params: { projectId: string; workspaceId: string }; Querystring: { fromPath?: string; toPath?: string; createDirs?: string; overwrite?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/move`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const fromMutationPath = await resolveWorkspaceFileMutationPath(context.root, request.query.fromPath, {
        stopAt: isWorkspaceTasksPath,
        followFinalSymlink: true,
      });
      const toMutationPath = await resolveWorkspaceFileMutationPath(context.root, request.query.toPath, {
        stopAt: isWorkspaceTasksPath,
        followFinalSymlink: false,
      });
      const taskFiles = options.taskFiles;
      const fromTaskPath = taskFiles === undefined ? undefined : fromMutationPath.resolvedPaths.find(isWorkspaceTasksPath);
      const toTaskPath = taskFiles === undefined ? undefined : toMutationPath.resolvedPaths.find(isWorkspaceTasksPath);
      if (taskFiles !== undefined && (fromTaskPath !== undefined || toTaskPath !== undefined)) {
        const normalizedMove: WorkspaceTasksNormalizedFileMove = {
          fromPath: fromTaskPath ?? fromMutationPath.normalizedPath,
          toPath: toTaskPath ?? toMutationPath.normalizedPath,
          createDirs: request.query.createDirs !== "false",
          overwrite: request.query.overwrite === "true",
        };
        const operation = () => taskFiles.moveExplorerTaskFile(
          { projectId: request.params.projectId, workspaceId: request.params.workspaceId },
          normalizedMove,
        );
        if (options.taskPathGate !== undefined) {
          return await options.taskPathGate.run(
            { projectId: request.params.projectId, workspaceId: request.params.workspaceId },
            [normalizedMove.fromPath, normalizedMove.toPath],
            operation,
          );
        }
        return await operation();
      }
      return await moveWorkspaceFile(context.root, request.query.fromPath, request.query.toPath, {
        createDirs: request.query.createDirs !== "false",
        overwrite: request.query.overwrite === "true",
      });
    } catch (error) {
      return sendWorkspaceExplorerError(reply, error);
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/preview`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const preview = await readWorkspaceImagePreview(context.root, request.query.path, await pathAccessForWorkspaceContext(context, options.config));
      return await reply
        .type(preview.mimeType)
        .header("Cache-Control", "private, max-age=3600")
        .header("Content-Length", String(preview.size))
        .header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'")
        .header("Last-Modified", new Date(preview.modifiedAt).toUTCString())
        .header("X-Content-Type-Options", "nosniff")
        .send(preview.stream);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: unknown } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/view`, async (request, reply) => {
    const plain = (status: number, message: string) => reply.code(status).type("text/plain; charset=utf-8").header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer").send(message);
    const path = request.query.path;
    if (path !== undefined && typeof path !== "string") return plain(400, "path query parameter must be a single string");
    if (path === undefined || path === "") return plain(400, "path query parameter is required");
    if (path.includes("\0")) return plain(400, "path query parameter must not contain NUL bytes");
    const disconnect = createReplyDisconnectScope(reply);
    const abandoned = () => disconnect.signal.aborted || reply.raw.destroyed;
    if (abandoned()) { disconnect.dispose(); return reply; }
    try {
      let context: Awaited<ReturnType<typeof resolveWorkspaceContext>>;
      try { context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId); }
      catch (error) {
        disconnect.dispose(); if (abandoned()) return await reply;
        if (error instanceof ProjectNotFoundError) return await plain(404, "Project not found");
        if (error instanceof Error && error.message === "Workspace not found") return await plain(404, "Workspace not found");
        throw error;
      }
      if (abandoned()) { disconnect.dispose(); return await reply; }
      const access = await pathAccessForWorkspaceContext(context, options.config);
      if (abandoned()) { disconnect.dispose(); return await reply; }
      const view = await (options.openFileView ?? openWorkspaceFileView)(context.root, path, access);
      if (abandoned()) {
        view.stream.on("error", (error) => { request.log.error({ err: error }, "abandoned file view failed"); });
        view.stream.destroy();
        disconnect.dispose();
        return await reply;
      }
      return await sendWorkspaceFileView(reply, view, disconnect);
    } catch (error) {
      disconnect.dispose(); if (abandoned()) return reply;
      if (reply.raw.headersSent) { reply.raw.destroy(error instanceof Error ? error : new Error(String(error))); return reply; }
      if (error instanceof FileViewError) return await plain(error.status, error.message);
      request.log.error({ err: error }, "unable to preview workspace file");
      return plain(500, "Unable to preview this file.");
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { q?: string; kind?: "tracked" | "untracked" | "other"; mode?: "file" | "path"; scope?: "tracked" | "all" } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/files`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const query = request.query.q ?? "";
      const pathAccess = isAbsoluteishFileSuggestionQuery(query) ? await pathAccessForWorkspaceContext(context, options.config) : undefined;
      if (request.query.mode === "path") return await listPathSuggestions(context.root, query, pathAccess);
      return await listFileSuggestions(context.root, query, { kind: request.query.kind, scope: request.query.scope, pathAccess });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function sendWorkspaceExplorerError(reply: FastifyReply, error: unknown): FastifyReply {
  const status = error instanceof WorkspaceTasksMoveInProgressError
    || error instanceof WorkspaceTasksMoveRecoveryPendingError
    || error instanceof WorkspaceTasksMoveConflictError
    ? 409
    : 400;
  return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
}

function registerWorkspaceFileContentParsers(app: FastifyInstance): void {
  // Fastify's default parser only handles JSON; workspace file writes need to
  // accept text and arbitrary binary payloads. This route module is registered
  // for both local aliases, so parser registration must tolerate repeats.
  try { app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => { done(null, Buffer.from(body)); }); } catch { /* already registered */ }
  try { app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); }); } catch { /* already registered */ }
  try { app.addContentTypeParser(/^([a-z]+\/[a-z0-9.+-]+)$/u, { parseAs: "buffer" }, (_request, body, done) => { done(null, body); }); } catch { /* already registered */ }
}
