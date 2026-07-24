import type { WriteWorkspaceFileResponse } from "../../shared/apiTypes";
import { workspaceUploadPath, type WorkspaceUploadBatchProgress } from "./api/workspaceUploads";

export type WorkspaceUploadFileStatus = "pending" | "uploading" | "completed" | "error" | "cancelled";
export type WorkspaceUploadBatchStatus = "uploading" | "completed" | "error" | "cancelled";

export interface WorkspaceUploadFileState {
  index: number;
  name: string;
  path: string;
  size: number;
  loaded: number;
  total: number;
  percent: number;
  lengthComputable: boolean;
  status: WorkspaceUploadFileStatus;
  error?: string;
  response?: WriteWorkspaceFileResponse;
}

export interface WorkspaceUploadBatchState {
  id: string;
  projectId: string;
  workspaceId: string;
  machineId: string;
  destinationFolder: string;
  overwrite: boolean;
  createDirs: boolean;
  files: WorkspaceUploadFileState[];
  currentFileIndex: number;
  loaded: number;
  total: number;
  percent: number;
  status: WorkspaceUploadBatchStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface WorkspaceUploadFileLike {
  name: string;
  size: number;
}

export interface CreateWorkspaceUploadBatchStateInput {
  id: string;
  projectId: string;
  workspaceId: string;
  machineId: string;
  destinationFolder: string;
  overwrite: boolean;
  createDirs: boolean;
  files: readonly WorkspaceUploadFileLike[];
  startedAt: string;
}

export function createWorkspaceUploadBatchState(input: CreateWorkspaceUploadBatchStateInput): WorkspaceUploadBatchState {
  const files = input.files.map((file, index): WorkspaceUploadFileState => {
    const total = file.size;
    return {
      index,
      name: file.name,
      path: workspaceUploadPath(input.destinationFolder, file.name),
      size: file.size,
      loaded: 0,
      total,
      percent: percentFor(0, total),
      lengthComputable: true,
      status: index === 0 ? "uploading" : "pending",
    };
  });
  const total = files.reduce((sum, file) => sum + file.total, 0);
  return {
    id: input.id,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    machineId: input.machineId,
    destinationFolder: input.destinationFolder,
    overwrite: input.overwrite,
    createDirs: input.createDirs,
    files,
    currentFileIndex: files.length === 0 ? -1 : 0,
    loaded: 0,
    total,
    percent: percentFor(0, total),
    status: "uploading",
    startedAt: input.startedAt,
  };
}

export function updateWorkspaceUploadBatchProgress(batch: WorkspaceUploadBatchState, progress: WorkspaceUploadBatchProgress): WorkspaceUploadBatchState {
  const progressByIndex = new Map(progress.files.map((file) => [file.index, file]));
  const files = batch.files.map((file): WorkspaceUploadFileState => {
    const progressFile = progressByIndex.get(file.index);
    if (progressFile === undefined) return file;
    const next: WorkspaceUploadFileState = {
      ...file,
      path: progressFile.path,
      loaded: progressFile.loaded,
      total: progressFile.total,
      percent: progressFile.percent,
      lengthComputable: progressFile.lengthComputable,
      status: progressFile.error !== undefined ? "error" : progressFile.done ? "completed" : progress.currentFileIndex === file.index ? "uploading" : file.status,
    };
    if (progressFile.error === undefined) delete next.error;
    else next.error = progressFile.error;
    return next;
  });
  return {
    ...batch,
    files,
    currentFileIndex: progress.currentFileIndex,
    loaded: progress.loaded,
    total: progress.total,
    percent: progress.percent,
  };
}

export function completeWorkspaceUploadBatch(batch: WorkspaceUploadBatchState, responses: readonly WriteWorkspaceFileResponse[], completedAt: string): WorkspaceUploadBatchState {
  const files = batch.files.map((file, index): WorkspaceUploadFileState => {
    const response = responses[index];
    return {
      ...file,
      ...(response === undefined ? {} : { path: response.path, response }),
      loaded: file.total,
      percent: 1,
      lengthComputable: true,
      status: "completed",
    };
  });
  const progress = terminalBatchProgress(files);
  return {
    ...batch,
    files,
    currentFileIndex: files.length === 0 ? -1 : files.length - 1,
    ...progress,
    status: "completed",
    completedAt,
  };
}

export function failWorkspaceUploadBatch(batch: WorkspaceUploadBatchState, error: string, completedAt: string): WorkspaceUploadBatchState {
  const files = batch.files.map((file): WorkspaceUploadFileState => {
    if (file.status === "completed" || file.status === "error") return file;
    if (file.status === "uploading" || file.index === batch.currentFileIndex) return { ...file, status: "error", error };
    return { ...file, status: "cancelled", error: "Not uploaded because an earlier file failed." };
  });
  return {
    ...batch,
    files,
    ...terminalBatchProgress(files),
    status: "error",
    error,
    completedAt,
  };
}

export function cancelWorkspaceUploadBatch(batch: WorkspaceUploadBatchState, completedAt: string): WorkspaceUploadBatchState {
  const error = "Upload cancelled";
  const files = batch.files.map((file): WorkspaceUploadFileState => file.status === "completed" || file.status === "error" ? file : { ...file, status: "cancelled", error });
  return {
    ...batch,
    files,
    ...terminalBatchProgress(files),
    status: "cancelled",
    error,
    completedAt,
  };
}

function terminalBatchProgress(files: readonly WorkspaceUploadFileState[]): Pick<WorkspaceUploadBatchState, "loaded" | "total" | "percent"> {
  const total = files.reduce((sum, file) => sum + file.total, 0);
  return { loaded: total, total, percent: files.length === 0 ? 0 : 1 };
}

function percentFor(loaded: number, total: number): number {
  if (total <= 0) return loaded <= 0 ? 0 : 1;
  return Math.max(0, Math.min(1, loaded / total));
}
