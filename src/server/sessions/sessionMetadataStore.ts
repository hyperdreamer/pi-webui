import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { piWebUiDataDir } from "../../config.js";

export interface SessionMetadata {
  pinned?: boolean;
}

export function defaultSessionMetadataFilePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebUiDataDir(env, cwd), "session-metadata.json");
}

export class SessionMetadataStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = defaultSessionMetadataFilePath()) {}

  async get(sessionPath: string): Promise<SessionMetadata | undefined> {
    const data = await this.read();
    return data[sessionPath];
  }

  async pin(sessionPath: string): Promise<void> {
    await this.update(sessionPath, { pinned: true });
  }

  async unpin(sessionPath: string): Promise<void> {
    await this.update(sessionPath, { pinned: false });
  }

  async pinnedPaths(): Promise<string[]> {
    const data = await this.read();
    return Object.entries(data)
      .filter(([, meta]) => meta.pinned === true)
      .map(([path]) => path);
  }

  private async update(sessionPath: string, meta: SessionMetadata): Promise<void> {
    await this.exclusive(async () => {
      const data = await this.read();
      const existing = data[sessionPath] ?? {};
      data[sessionPath] = { ...existing, ...meta };
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
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseMetadataFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return {};
      throw error;
    }
  }

  private async write(data: Record<string, SessionMetadata>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = join(dirname(this.filePath), `.${basename(this.filePath)}.${String(process.pid)}.${Date.now().toString()}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error: unknown) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
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
  return { ...(pinned === undefined ? {} : { pinned }) };
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid boolean field: ${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
