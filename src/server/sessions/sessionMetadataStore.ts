import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { piWebUiDataDir } from "../../config.js";
import type { SessionReorderScope } from "../../shared/apiTypes.js";

export interface SessionOrderMetadata {
  position: number;
  scope: SessionReorderScope;
  pinned: boolean;
}

export interface SessionMetadata {
  pinned?: boolean;
  order?: SessionOrderMetadata;
}

export interface SessionMetadataFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultFileSystem: SessionMetadataFileSystem = {
  readFile,
  mkdir,
  writeFile,
  rename,
  unlink,
};

export function defaultSessionMetadataFilePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebUiDataDir(env, cwd), "session-metadata.json");
}

export class SessionMetadataStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = defaultSessionMetadataFilePath(),
    private readonly fileSystem: SessionMetadataFileSystem = defaultFileSystem,
  ) {}

  async get(sessionPath: string): Promise<SessionMetadata | undefined> {
    const data = await this.read();
    return data[sessionPath];
  }

  async snapshot(): Promise<Record<string, SessionMetadata>> {
    return await this.read();
  }

  async pin(sessionPath: string): Promise<void> {
    await this.update(sessionPath, (existing) => ({ ...withoutOrder(existing), pinned: true }));
  }

  async unpin(sessionPath: string): Promise<void> {
    await this.update(sessionPath, (existing) => ({ ...withoutOrder(existing), pinned: false }));
  }

  async clearOrder(sessionPath: string): Promise<void> {
    await this.update(sessionPath, withoutOrder);
  }

  async pinnedPaths(): Promise<string[]> {
    const data = await this.read();
    return Object.entries(data)
      .filter(([, meta]) => meta.pinned === true)
      .map(([path]) => path);
  }

  private async update(
    sessionPath: string,
    mutate: (existing: SessionMetadata) => SessionMetadata,
  ): Promise<void> {
    await this.exclusive(async () => {
      const data = await this.read();
      data[sessionPath] = mutate(data[sessionPath] ?? {});
      await this.write(data);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async read(): Promise<Record<string, SessionMetadata>> {
    try {
      const value: unknown = JSON.parse(await this.fileSystem.readFile(this.filePath, "utf8"));
      return parseMetadataFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return {};
      throw error;
    }
  }

  private async write(data: Record<string, SessionMetadata>): Promise<void> {
    await this.fileSystem.mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = join(dirname(this.filePath), `.${basename(this.filePath)}.${String(process.pid)}.${Date.now().toString()}.${randomUUID()}.tmp`);
    try {
      await this.fileSystem.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await this.fileSystem.rename(tempPath, this.filePath);
    } catch (error: unknown) {
      await this.fileSystem.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

function withoutOrder(metadata: SessionMetadata): SessionMetadata {
  const { order: _order, ...rest } = metadata;
  void _order;
  return rest;
}

function parseMetadataFile(value: unknown): Record<string, SessionMetadata> {
  if (!isRecord(value)) throw new Error("Invalid session metadata file");
  const result: Record<string, SessionMetadata> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = parseMetadataEntry(entry);
  }
  return result;
}

function parseMetadataEntry(value: unknown): SessionMetadata {
  if (!isRecord(value)) throw new Error("Invalid session metadata entry");
  const pinned = optionalBoolean(value, "pinned");
  const order = parseOptionalOrder(value["order"]);
  return {
    ...(pinned === undefined ? {} : { pinned }),
    ...(order === undefined ? {} : { order }),
  };
}

function parseOptionalOrder(value: unknown): SessionOrderMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid session metadata order");
  const allowedKeys = new Set(["position", "scope", "pinned"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error("Invalid session metadata order");
  }
  const position = value["position"];
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || !Number.isSafeInteger(position)) {
    throw new Error("Invalid session metadata order");
  }
  const scope = parseOrderScope(value["scope"]);
  const pinned = value["pinned"];
  if (typeof pinned !== "boolean") throw new Error("Invalid session metadata order");
  return { position, scope, pinned };
}

function parseOrderScope(value: unknown): SessionReorderScope {
  if (!isRecord(value)) throw new Error("Invalid session metadata order");
  const kind = value["kind"];
  if (kind === "root") {
    const allowedKeys = new Set(["kind", "cwd"]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) throw new Error("Invalid session metadata order");
    }
    const cwd = value["cwd"];
    if (typeof cwd !== "string" || cwd === "") throw new Error("Invalid session metadata order");
    return { kind: "root", cwd };
  }
  if (kind === "children") {
    const allowedKeys = new Set(["kind", "parentSessionPath"]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) throw new Error("Invalid session metadata order");
    }
    const parentSessionPath = value["parentSessionPath"];
    if (typeof parentSessionPath !== "string" || parentSessionPath === "") throw new Error("Invalid session metadata order");
    return { kind: "children", parentSessionPath };
  }
  throw new Error("Invalid session metadata order");
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid boolean field: ${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
