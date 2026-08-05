import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { piWebUiDataDir } from "../../config.js";
import { addUsageTotals, emptyUsageTotals, readSessionHeaderId, scanSessionUsage, type UsageTotals } from "./sessionUsageScanner.js";

export interface SessionUsageCacheEntry extends UsageTotals {
  size: number;
  mtimeMs: number;
  bytesScanned: number;
  headerId?: string;
}

export interface SessionUsageCacheFile {
  sessions: Record<string, SessionUsageCacheEntry>;
}

export function defaultSessionUsageCachePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebUiDataDir(env, cwd), "usage-cache.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseEntry(value: unknown): SessionUsageCacheEntry | undefined {
  if (!isRecord(value)) return undefined;
  const headerId = value["headerId"];
  return {
    input: numberAt(value, "input"),
    output: numberAt(value, "output"),
    cacheRead: numberAt(value, "cacheRead"),
    cacheWrite: numberAt(value, "cacheWrite"),
    cost: numberAt(value, "cost"),
    size: numberAt(value, "size"),
    mtimeMs: numberAt(value, "mtimeMs"),
    bytesScanned: numberAt(value, "bytesScanned"),
    ...(typeof headerId === "string" ? { headerId } : {}),
  };
}

function parseCacheFile(value: unknown): SessionUsageCacheFile {
  if (!isRecord(value) || !isRecord(value["sessions"])) return { sessions: {} };
  const sessions: Record<string, SessionUsageCacheEntry> = {};
  for (const [sessionId, entry] of Object.entries(value["sessions"])) {
    const parsed = parseEntry(entry);
    if (parsed !== undefined) sessions[sessionId] = parsed;
  }
  return { sessions };
}

function totalsOf(entry: SessionUsageCacheEntry): UsageTotals {
  return { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite, cost: entry.cost };
}

/**
 * Per-session usage totals keyed by session UUID.
 *
 * Purely derived state: any entry may be discarded and rebuilt from the session
 * file, so a corrupt or missing cache file is treated as empty rather than an
 * error. Keying on UUID rather than path matters because archiving moves a
 * session file into the PI WEBUI archive directory without changing its id.
 */
export class SessionUsageCacheStore {
  private loaded: SessionUsageCacheFile | undefined;
  private dirty = false;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = defaultSessionUsageCachePath()) {}

  async totalsFor(sessionId: string, path: string): Promise<UsageTotals> {
    return this.exclusive(async () => {
      const data = await this.read();
      let fileStats: { size: number; mtimeMs: number };
      try {
        const stats = await stat(path);
        fileStats = { size: stats.size, mtimeMs: stats.mtimeMs };
      } catch {
        return emptyUsageTotals();
      }

      const existing = data.sessions[sessionId];
      if (existing?.size === fileStats.size && existing.mtimeMs === fileStats.mtimeMs) {
        return totalsOf(existing);
      }

      const headerId = await readSessionHeaderId(path);
      const canResume =
        existing !== undefined
        && fileStats.size >= existing.size
        && existing.bytesScanned <= fileStats.size
        && existing.headerId === headerId;

      const startOffset = canResume ? existing.bytesScanned : 0;
      const base = canResume ? totalsOf(existing) : emptyUsageTotals();
      const scan = await scanSessionUsage(path, startOffset);
      const totals = addUsageTotals(base, scan.totals);

      data.sessions[sessionId] = {
        ...totals,
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
        bytesScanned: scan.bytesScanned,
        ...(headerId === undefined ? {} : { headerId }),
      };
      this.dirty = true;
      return totals;
    });
  }

  async snapshot(): Promise<Record<string, SessionUsageCacheEntry>> {
    return this.exclusive(async () => ({ ...(await this.read()).sessions }));
  }

  async flush(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.dirty || this.loaded === undefined) return;
      await this.write(this.loaded);
      this.dirty = false;
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

  private async read(): Promise<SessionUsageCacheFile> {
    if (this.loaded !== undefined) return this.loaded;
    try {
      this.loaded = parseCacheFile(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      this.loaded = { sessions: {} };
    }
    return this.loaded;
  }

  private async write(data: SessionUsageCacheFile): Promise<void> {
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
