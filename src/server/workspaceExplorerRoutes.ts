import type { FastifyInstance, FastifyReply } from "fastify";
import type { WriteWorkspaceFileOptions } from "../shared/apiTypes.js";
import type { PiWebUiConfigService } from "./configRoutes.js";
import type { ProjectService } from "./projects/projectService.js";
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
      const mutationPath = await resolveWorkspaceFileMutationPath(context.root, request.query.path, { stopAt: isWorkspaceTasksPath });
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
      const mutationPath = await resolveWorkspaceFileMutationPath(context.root, request.query.path, { stopAt: isWorkspaceTasksPath });
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
      const fromMutationPath = await resolveWorkspaceFileMutationPath(context.root, request.query.fromPath, { stopAt: isWorkspaceTasksPath });
      const toMutationPath = await resolveWorkspaceFileMutationPath(context.root, request.query.toPath, { stopAt: isWorkspaceTasksPath });
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
