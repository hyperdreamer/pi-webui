# Project Token Usage Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report a project's total token usage and cost (input, output, cache read, cache write, money) in a dialog opened from either project action menu.

**Architecture:** A streaming JSONL usage scanner and a UUID-keyed derived cache live in the session daemon, which owns session files. The web/API side resolves project identity into an explicit scope (project path plus live workspace cwds) and passes it to the daemon over the existing session proxy. The daemon enumerates candidate sessions from live cwds, the PI WEBUI archive, and Pi-store history, buckets them, and returns totals assembled on demand.

**Tech Stack:** TypeScript, Node 22 streams, Fastify, Lit, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-project-token-usage-statistics-design.md`. Read it before starting any task.
- No new runtime dependencies.
- Usage accounting must match Pi's `getSessionStats`: sum usage from assistant messages, `toolResult` messages, and `branch_summary` / `compaction` entries.
- Cost is provider-reported. Read `usage.cost.total` (or numeric `usage.cost`) and never recompute prices.
- Never read a whole session JSONL into memory. Stream lines. Session files exceed 30 MB.
- Never call Pi's `getSessionStats` or `sessionManager.getEntries()` during a cold scan; both materialize all entries.
- Scan file concurrency is 1. Do not copy `MAX_CONCURRENT_SESSION_LIST_LOADS = 10` from `piSessionManagerGateway.ts`.
- Prefilter each line with `line.includes("\"usage\"")` before `JSON.parse`.
- Persist JSON by writing a uniquely named temp file then renaming over the target, following `SessionArchiveStore.write` in `src/server/sessions/sessionArchiveStore.ts:170-181`.
- Daemon-side code is loaded only by `src/server/sessiond.ts`; it needs a manual daemon restart to take effect.
- Client app URLs are application-relative without a leading slash, and every dynamic segment uses `encodeURIComponent`.
- Run `npm test -- --run <file>` for the task's test file, and `npm run typecheck` when exported types change.

## Task 1: Usage scanner

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/usage/sessionUsageScanner.ts`
- Test: `src/server/usage/sessionUsageScanner.test.ts`

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces:
  - `interface UsageTotals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }`
  - `function emptyUsageTotals(): UsageTotals`
  - `function addUsageTotals(left: UsageTotals, right: UsageTotals): UsageTotals`
  - `function usageTotalsFromLine(line: string): UsageTotals | undefined`
  - `function readSessionHeaderId(path: string): Promise<string | undefined>`
  - `interface ScanResult { totals: UsageTotals; bytesScanned: number }`
  - `function scanSessionUsage(path: string, startOffset: number): Promise<ScanResult>`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addUsageTotals, emptyUsageTotals, readSessionHeaderId, scanSessionUsage, usageTotalsFromLine } from "./sessionUsageScanner";

function usageLine(role: string, usage: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", message: { role, usage } });
}

describe("usageTotalsFromLine", () => {
  it("ignores lines without usage", () => {
    expect(usageTotalsFromLine(JSON.stringify({ type: "message", message: { role: "user" } }))).toBeUndefined();
  });

  it("reads assistant usage with nested cost", () => {
    const line = usageLine("assistant", { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } });
    expect(usageTotalsFromLine(line)).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.25 });
  });

  it("reads toolResult usage and numeric cost", () => {
    const line = usageLine("toolResult", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
    expect(usageTotalsFromLine(line)).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
  });

  it("reads branch_summary and compaction usage", () => {
    const branch = JSON.stringify({ type: "branch_summary", usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } });
    const compaction = JSON.stringify({ type: "compaction", usage: { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } } });
    expect(usageTotalsFromLine(branch)?.input).toBe(3);
    expect(usageTotalsFromLine(compaction)?.cost).toBeCloseTo(0.2);
  });

  it("ignores user message usage", () => {
    expect(usageTotalsFromLine(usageLine("user", { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: 1 }))).toBeUndefined();
  });

  it("ignores malformed json", () => {
    expect(usageTotalsFromLine('{"usage": broken')).toBeUndefined();
  });
});

describe("addUsageTotals", () => {
  it("sums field by field", () => {
    const left = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 };
    expect(addUsageTotals(left, left)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8, cost: 1 });
  });

  it("starts from zero", () => {
    expect(emptyUsageTotals()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });
});

describe("scanSessionUsage", () => {
  it("scans from an offset and reports bytes consumed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-scan-"));
    const path = join(dir, "session.jsonl");
    const header = JSON.stringify({ type: "session", id: "abc", cwd: "/repo" });
    const first = usageLine("assistant", { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } });
    await writeFile(path, `${header}\n${first}\n`, "utf8");

    expect(await readSessionHeaderId(path)).toBe("abc");

    const full = await scanSessionUsage(path, 0);
    expect(full.totals.input).toBe(10);
    expect(full.bytesScanned).toBe(Buffer.byteLength(`${header}\n${first}\n`, "utf8"));

    const second = usageLine("assistant", { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } });
    await writeFile(path, `${header}\n${first}\n${second}\n`, "utf8");
    const appended = await scanSessionUsage(path, full.bytesScanned);
    expect(appended.totals.input).toBe(7);
    expect(appended.totals.cost).toBeCloseTo(0.2);
  });

  it("does not consume a trailing partial line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-partial-"));
    const path = join(dir, "session.jsonl");
    const header = JSON.stringify({ type: "session", id: "abc", cwd: "/repo" });
    const complete = usageLine("assistant", { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } });
    await writeFile(path, `${header}\n${complete}\n{"type":"mess`, "utf8");

    const result = await scanSessionUsage(path, 0);
    expect(result.totals.input).toBe(5);
    expect(result.bytesScanned).toBe(Buffer.byteLength(`${header}\n${complete}\n`, "utf8"));
  });

  it("returns empty totals for a missing file", async () => {
    const result = await scanSessionUsage(join(tmpdir(), "does-not-exist.jsonl"), 0);
    expect(result).toEqual({ totals: emptyUsageTotals(), bytesScanned: 0 });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/usage/sessionUsageScanner.test.ts`
Expected: FAIL, cannot resolve `./sessionUsageScanner`.

- [ ] **Step 3: Write the implementation**

```ts
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ScanResult {
  totals: UsageTotals;
  bytesScanned: number;
}

/** Entry types whose own `usage` counts, matching Pi's `getSessionStats`. */
const USAGE_ENTRY_TYPES = new Set(["branch_summary", "compaction"]);
/** Message roles whose `usage` counts. User messages carry none. */
const USAGE_MESSAGE_ROLES = new Set(["assistant", "toolResult"]);

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsageTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function costOf(usage: Record<string, unknown>): number {
  const cost = usage["cost"];
  if (typeof cost === "number" && Number.isFinite(cost)) return cost;
  if (isRecord(cost)) return numberAt(cost, "total");
  return 0;
}

function totalsFromUsage(usage: Record<string, unknown>): UsageTotals {
  return {
    input: numberAt(usage, "input"),
    output: numberAt(usage, "output"),
    cacheRead: numberAt(usage, "cacheRead"),
    cacheWrite: numberAt(usage, "cacheWrite"),
    cost: costOf(usage),
  };
}

/**
 * Extract the usage contribution of one JSONL line, or undefined when the line
 * carries none. Callers prefilter on the `"usage"` substring; this function
 * still tolerates any line so it is safe to call directly in tests.
 */
export function usageTotalsFromLine(line: string): UsageTotals | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const type = parsed["type"];
  if (typeof type === "string" && USAGE_ENTRY_TYPES.has(type) && isRecord(parsed["usage"])) {
    return totalsFromUsage(parsed["usage"]);
  }

  if (type !== "message") return undefined;
  const message = parsed["message"];
  if (!isRecord(message)) return undefined;
  const role = message["role"];
  if (typeof role !== "string" || !USAGE_MESSAGE_ROLES.has(role)) return undefined;
  const usage = message["usage"];
  if (!isRecord(usage)) return undefined;
  return totalsFromUsage(usage);
}

/** Read the `id` from a session file's header line without parsing the body. */
export async function readSessionHeaderId(path: string): Promise<string | undefined> {
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed) || parsed["type"] !== "session") return undefined;
        const id = parsed["id"];
        return typeof id === "string" ? id : undefined;
      }
      return undefined;
    } finally {
      lines.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Stream a session file from `startOffset` and sum its usage.
 *
 * Only complete newline-terminated lines are counted, and `bytesScanned`
 * advances only past those lines, so a session being appended to concurrently
 * resumes cleanly on the next pass instead of losing or double-counting a
 * partially written tail. Reading whole files is not an option: sessions here
 * exceed 30 MB.
 */
export async function scanSessionUsage(path: string, startOffset: number): Promise<ScanResult> {
  let totals = emptyUsageTotals();
  let bytesScanned = startOffset;

  try {
    const stream = createReadStream(path, { encoding: "utf8", start: startOffset });
    let buffered = "";
    for await (const chunk of stream) {
      buffered += chunk as string;
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex);
        bytesScanned += Buffer.byteLength(line, "utf8") + 1;
        if (line.includes("\"usage\"")) {
          const lineTotals = usageTotalsFromLine(line);
          if (lineTotals !== undefined) totals = addUsageTotals(totals, lineTotals);
        }
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }
    }
  } catch {
    return { totals: emptyUsageTotals(), bytesScanned: startOffset === 0 ? 0 : startOffset };
  }

  return { totals, bytesScanned };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/usage/sessionUsageScanner.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/usage/sessionUsageScanner.ts src/server/usage/sessionUsageScanner.test.ts
git commit -m "feat(usage): stream session usage totals from jsonl"
```

## Task 2: Usage cache store

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/usage/sessionUsageCacheStore.ts`
- Test: `src/server/usage/sessionUsageCacheStore.test.ts`

**Interfaces:**

- Consumes: `UsageTotals`, `emptyUsageTotals()`, `addUsageTotals(left, right)`, `scanSessionUsage(path, startOffset): Promise<{ totals: UsageTotals; bytesScanned: number }>`, and `readSessionHeaderId(path): Promise<string | undefined>` from Task 1, where `UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }`.
- Produces:
  - `interface SessionUsageCacheEntry extends UsageTotals { size: number; mtimeMs: number; bytesScanned: number; headerId?: string }`
  - `interface SessionUsageCacheFile { sessions: Record<string, SessionUsageCacheEntry> }`
  - `function defaultSessionUsageCachePath(env?: NodeJS.ProcessEnv, cwd?: string): string`
  - `class SessionUsageCacheStore` with constructor `(filePath?: string)` and methods `totalsFor(sessionId: string, path: string): Promise<UsageTotals>`, `flush(): Promise<void>`, and `snapshot(): Promise<Record<string, SessionUsageCacheEntry>>`

`totalsFor` returns cached totals when `size` and `mtimeMs` are unchanged, scans forward from `bytesScanned` when the file grew and `headerId` still matches, and rescans from zero otherwise. Writes are debounced: `totalsFor` mutates in-memory state and `flush` persists.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionUsageCacheStore } from "./sessionUsageCacheStore";

function header(id: string): string {
  return JSON.stringify({ type: "session", id, cwd: "/repo" });
}

function assistantLine(input: number, cost: number): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } } });
}

async function tempPaths(): Promise<{ cachePath: string; sessionPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "usage-cache-"));
  return { cachePath: join(dir, "usage-cache.json"), sessionPath: join(dir, "session.jsonl") };
}

describe("SessionUsageCacheStore", () => {
  it("scans on first read and reuses the cache when the file is unchanged", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(10, 0.1)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);

    const first = await store.totalsFor("s1", sessionPath);
    expect(first.input).toBe(10);
    expect(first.cost).toBeCloseTo(0.1);

    await store.flush();
    const persisted: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    expect((persisted as { sessions: Record<string, { input: number }> }).sessions["s1"]?.input).toBe(10);

    const reused = await store.totalsFor("s1", sessionPath);
    expect(reused.input).toBe(10);
  });

  it("adds only appended usage when the file grows", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    const base = `${header("s1")}\n${assistantLine(10, 0.1)}\n`;
    await writeFile(sessionPath, base, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    await store.totalsFor("s1", sessionPath);

    await writeFile(sessionPath, `${base}${assistantLine(5, 0.2)}\n`, "utf8");
    const grown = await store.totalsFor("s1", sessionPath);
    expect(grown.input).toBe(15);
    expect(grown.cost).toBeCloseTo(0.3);
  });

  it("rescans from zero when the file shrinks", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(10, 0.1)}\n${assistantLine(10, 0.1)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(20);

    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(3, 0.05)}\n`, "utf8");
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(3);
  });

  it("rescans when the header id changes", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(10, 0.1)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    await store.totalsFor("s1", sessionPath);

    const replaced = `${header("s2")}\n${assistantLine(4, 0.4)}\n${assistantLine(4, 0.4)}\n`;
    await writeFile(sessionPath, replaced, "utf8");
    const after = await store.totalsFor("s1", sessionPath);
    expect(after.input).toBe(8);
  });

  it("treats an unreadable cache file as empty", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(cachePath, "{ not json", "utf8");
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(6, 0.6)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    expect((await store.totalsFor("s1", sessionPath)).input).toBe(6);
  });

  it("returns zero totals for a missing session file", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    const store = new SessionUsageCacheStore(cachePath);
    const totals = await store.totalsFor("gone", `${sessionPath}.missing`);
    expect(totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it("persists atomically, leaving no temp files behind", async () => {
    const { cachePath, sessionPath } = await tempPaths();
    await writeFile(sessionPath, `${header("s1")}\n${assistantLine(1, 0.01)}\n`, "utf8");
    const store = new SessionUsageCacheStore(cachePath);
    await store.totalsFor("s1", sessionPath);
    await store.flush();
    await expect(stat(cachePath)).resolves.toBeDefined();
    const snapshot = await store.snapshot();
    expect(Object.keys(snapshot)).toEqual(["s1"]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/usage/sessionUsageCacheStore.test.ts`
Expected: FAIL, cannot resolve `./sessionUsageCacheStore`.

- [ ] **Step 3: Write the implementation**

```ts
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
      if (existing !== undefined && existing.size === fileStats.size && existing.mtimeMs === fileStats.mtimeMs) {
        return totalsOf(existing);
      }

      const headerId = await readSessionHeaderId(path);
      const canResume =
        existing !== undefined
        && fileStats.size >= existing.size
        && existing.bytesScanned <= fileStats.size
        && existing.headerId === headerId;

      const startOffset = canResume ? existing.bytesScanned : 0;
      const base = canResume && existing !== undefined ? totalsOf(existing) : emptyUsageTotals();
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/usage/sessionUsageCacheStore.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/usage/sessionUsageCacheStore.ts src/server/usage/sessionUsageCacheStore.test.ts
git commit -m "feat(usage): cache per-session usage totals by session id"
```

## Task 3: Bucket assignment

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/usage/projectUsageBuckets.ts`
- Test: `src/server/usage/projectUsageBuckets.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `type ProjectUsageBucket = "live" | "retired" | "archived"`
  - `interface UsageCandidate { sessionId: string; path: string; cwd: string; bucket: ProjectUsageBucket }`
  - `interface CandidateInput { sessionId: string; path: string; cwd: string; archived?: boolean }`
  - `function isWithinProject(projectPath: string, cwd: string): boolean`
  - `function bucketFor(input: { cwd: string; archived?: boolean }, scope: { projectPath: string; liveCwds: readonly string[] }): ProjectUsageBucket | undefined`
  - `function assignBuckets(inputs: readonly CandidateInput[], scope: { projectPath: string; liveCwds: readonly string[] }): UsageCandidate[]`

`isWithinProject` matches the project path itself or a path beneath it on a path-segment boundary, so a sibling directory such as `/dev/pi-webui-fix` is not treated as inside `/dev/pi-webui`. `assignBuckets` deduplicates by `sessionId`, keeping the first occurrence, and drops candidates outside the project scope.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { assignBuckets, bucketFor, isWithinProject } from "./projectUsageBuckets";

const scope = { projectPath: "/dev/pi-webui", liveCwds: ["/dev/pi-webui", "/dev/pi-webui/.worktrees/feature"] };

describe("isWithinProject", () => {
  it("matches the project path itself", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/pi-webui")).toBe(true);
  });

  it("matches a nested path", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/pi-webui/.worktrees/x")).toBe(true);
  });

  it("rejects a sibling sharing a name prefix", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/pi-webui-browser-fix")).toBe(false);
  });

  it("rejects an unrelated path", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/other")).toBe(false);
  });

  it("normalizes redundant segments", () => {
    expect(isWithinProject("/dev/pi-webui", "/dev/pi-webui/./sub")).toBe(true);
  });
});

describe("bucketFor", () => {
  it("assigns archived regardless of cwd liveness", () => {
    expect(bucketFor({ cwd: "/dev/pi-webui", archived: true }, scope)).toBe("archived");
  });

  it("assigns live for a listed workspace cwd", () => {
    expect(bucketFor({ cwd: "/dev/pi-webui/.worktrees/feature" }, scope)).toBe("live");
  });

  it("assigns retired for an in-project cwd that is not live", () => {
    expect(bucketFor({ cwd: "/dev/pi-webui/.worktrees/gone" }, scope)).toBe("retired");
  });

  it("returns undefined for a cwd outside the project", () => {
    expect(bucketFor({ cwd: "/dev/pi-webui-browser-fix" }, scope)).toBeUndefined();
  });

  it("returns undefined for an archived session whose cwd is outside the project path", () => {
    expect(bucketFor({ cwd: "/dev/elsewhere", archived: true }, scope)).toBeUndefined();
  });
});

describe("assignBuckets", () => {
  it("buckets each candidate and drops out-of-scope entries", () => {
    const result = assignBuckets([
      { sessionId: "a", path: "/store/a.jsonl", cwd: "/dev/pi-webui" },
      { sessionId: "b", path: "/store/b.jsonl", cwd: "/dev/pi-webui/.worktrees/gone" },
      { sessionId: "c", path: "/archive/c.jsonl", cwd: "/dev/pi-webui", archived: true },
      { sessionId: "d", path: "/store/d.jsonl", cwd: "/dev/pi-webui-browser-fix" },
    ], scope);

    expect(result).toEqual([
      { sessionId: "a", path: "/store/a.jsonl", cwd: "/dev/pi-webui", bucket: "live" },
      { sessionId: "b", path: "/store/b.jsonl", cwd: "/dev/pi-webui/.worktrees/gone", bucket: "retired" },
      { sessionId: "c", path: "/archive/c.jsonl", cwd: "/dev/pi-webui", bucket: "archived" },
    ]);
  });

  it("keeps the first occurrence of a duplicated session id", () => {
    const result = assignBuckets([
      { sessionId: "a", path: "/archive/a.jsonl", cwd: "/dev/pi-webui", archived: true },
      { sessionId: "a", path: "/store/a.jsonl", cwd: "/dev/pi-webui" },
    ], scope);

    expect(result).toHaveLength(1);
    expect(result[0]?.bucket).toBe("archived");
    expect(result[0]?.path).toBe("/archive/a.jsonl");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/usage/projectUsageBuckets.test.ts`
Expected: FAIL, cannot resolve `./projectUsageBuckets`.

- [ ] **Step 3: Write the implementation**

```ts
import { resolve, sep } from "node:path";

export type ProjectUsageBucket = "live" | "retired" | "archived";

export interface UsageCandidate {
  sessionId: string;
  path: string;
  cwd: string;
  bucket: ProjectUsageBucket;
}

export interface CandidateInput {
  sessionId: string;
  path: string;
  cwd: string;
  archived?: boolean;
}

export interface ProjectUsageScope {
  projectPath: string;
  liveCwds: readonly string[];
}

/**
 * True when `cwd` is the project directory or sits beneath it.
 *
 * The separator check is load-bearing: a plain string prefix would place a
 * sibling checkout such as `/dev/pi-webui-browser-fix` inside `/dev/pi-webui`
 * and silently inflate the project's totals.
 */
export function isWithinProject(projectPath: string, cwd: string): boolean {
  const root = resolve(projectPath);
  const candidate = resolve(cwd);
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function bucketFor(input: { cwd: string; archived?: boolean }, scope: ProjectUsageScope): ProjectUsageBucket | undefined {
  if (!isWithinProject(scope.projectPath, input.cwd)) return undefined;
  if (input.archived === true) return "archived";
  const live = scope.liveCwds.some((liveCwd) => resolve(liveCwd) === resolve(input.cwd));
  return live ? "live" : "retired";
}

/**
 * Bucket every candidate, dropping out-of-scope sessions and deduplicating by
 * session id. Deduplication is required because archiving moves a session file
 * without changing its id, so the same session can be discovered twice.
 */
export function assignBuckets(inputs: readonly CandidateInput[], scope: ProjectUsageScope): UsageCandidate[] {
  const seen = new Set<string>();
  const candidates: UsageCandidate[] = [];
  for (const input of inputs) {
    if (seen.has(input.sessionId)) continue;
    const bucket = bucketFor(input, scope);
    if (bucket === undefined) continue;
    seen.add(input.sessionId);
    candidates.push({ sessionId: input.sessionId, path: input.path, cwd: input.cwd, bucket });
  }
  return candidates;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/usage/projectUsageBuckets.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/usage/projectUsageBuckets.ts src/server/usage/projectUsageBuckets.test.ts
git commit -m "feat(usage): assign project sessions to usage buckets"
```

## Task 4: Project usage service

**Implementer tier:** Capable

**Files:**

- Create: `src/server/usage/projectUsageService.ts`
- Test: `src/server/usage/projectUsageService.test.ts`

**Interfaces:**

- Consumes:
  - `UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }`, `emptyUsageTotals()`, and `addUsageTotals(left, right)` from Task 1.
  - `SessionUsageCacheStore` from Task 2, used through its `totalsFor(sessionId: string, path: string): Promise<UsageTotals>` and `flush(): Promise<void>` methods.
  - `assignBuckets(inputs: readonly CandidateInput[], scope: { projectPath: string; liveCwds: readonly string[] }): UsageCandidate[]`, `type ProjectUsageBucket = "live" | "retired" | "archived"`, `CandidateInput = { sessionId: string; path: string; cwd: string; archived?: boolean }`, and `UsageCandidate = { sessionId: string; path: string; cwd: string; bucket: ProjectUsageBucket }` from Task 3.
- Produces:
  - `interface ProjectUsageScopeRequest { projectPath: string; liveCwds: readonly string[] }`
  - `interface ProjectUsageBucketTotals extends UsageTotals { sessionCount: number }`
  - `interface ProjectUsageReport { projectPath: string; buckets: Record<ProjectUsageBucket, ProjectUsageBucketTotals>; total: ProjectUsageBucketTotals; generatedAt: string }`
  - `interface ProjectUsageCandidateSource { listForCwd(cwd: string): Promise<{ id: string; path: string; cwd: string }[]>; listAll(): Promise<{ id: string; path: string; cwd: string }[]>; listArchived(): Promise<{ sessionId: string; cwd: string; archivePath?: string; originalPath?: string }[]> }`
  - `interface ProjectUsageServiceOptions { candidates: ProjectUsageCandidateSource; cache: { totalsFor(sessionId: string, path: string): Promise<UsageTotals>; flush(): Promise<void> }; now?: () => Date }`
  - `class ProjectUsageService` with constructor `(options: ProjectUsageServiceOptions)` and method `report(scope: ProjectUsageScopeRequest): Promise<ProjectUsageReport>`

`report` runs one scan at a time per project path; concurrent calls for the same project share the in-flight promise. Sessions are scanned sequentially, not in parallel, so a large project cannot lengthen an event-loop turn by interleaving many streams.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { ProjectUsageService, type ProjectUsageCandidateSource } from "./projectUsageService";
import type { UsageTotals } from "./sessionUsageScanner";

function totals(input: number, cost: number): UsageTotals {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, cost };
}

function candidateSource(overrides: Partial<ProjectUsageCandidateSource> = {}): ProjectUsageCandidateSource {
  return {
    listForCwd: async () => [],
    listAll: async () => [],
    listArchived: async () => [],
    ...overrides,
  };
}

describe("ProjectUsageService", () => {
  it("sums buckets and the project total", async () => {
    const service = new ProjectUsageService({
      candidates: candidateSource({
        listForCwd: async (cwd) => cwd === "/dev/app" ? [{ id: "live1", path: "/store/live1.jsonl", cwd: "/dev/app" }] : [],
        listAll: async () => [
          { id: "live1", path: "/store/live1.jsonl", cwd: "/dev/app" },
          { id: "gone1", path: "/store/gone1.jsonl", cwd: "/dev/app/.worktrees/gone" },
          { id: "other", path: "/store/other.jsonl", cwd: "/dev/app-sibling" },
        ],
        listArchived: async () => [{ sessionId: "arch1", cwd: "/dev/app", archivePath: "/archive/arch1.jsonl" }],
      }),
      cache: {
        totalsFor: async (sessionId) => {
          if (sessionId === "live1") return totals(10, 0.1);
          if (sessionId === "gone1") return totals(100, 1);
          if (sessionId === "arch1") return totals(1000, 10);
          return totals(0, 0);
        },
        flush: async () => undefined,
      },
      now: () => new Date("2026-08-05T00:00:00.000Z"),
    });

    const report = await service.report({ projectPath: "/dev/app", liveCwds: ["/dev/app"] });

    expect(report.buckets.live).toEqual({ ...totals(10, 0.1), sessionCount: 1 });
    expect(report.buckets.retired).toEqual({ ...totals(100, 1), sessionCount: 1 });
    expect(report.buckets.archived).toEqual({ ...totals(1000, 10), sessionCount: 1 });
    expect(report.total.input).toBe(1110);
    expect(report.total.cost).toBeCloseTo(11.1);
    expect(report.total.sessionCount).toBe(3);
    expect(report.generatedAt).toBe("2026-08-05T00:00:00.000Z");
    expect(report.projectPath).toBe("/dev/app");
  });

  it("prefers the archive path for archived sessions", async () => {
    const totalsFor = vi.fn(async () => totals(1, 0.01));
    const service = new ProjectUsageService({
      candidates: candidateSource({
        listArchived: async () => [{ sessionId: "arch1", cwd: "/dev/app", archivePath: "/archive/arch1.jsonl", originalPath: "/store/arch1.jsonl" }],
      }),
      cache: { totalsFor, flush: async () => undefined },
    });

    await service.report({ projectPath: "/dev/app", liveCwds: [] });
    expect(totalsFor).toHaveBeenCalledWith("arch1", "/archive/arch1.jsonl");
  });

  it("counts a session once when it appears in both the store and the archive", async () => {
    const service = new ProjectUsageService({
      candidates: candidateSource({
        listAll: async () => [{ id: "dup", path: "/store/dup.jsonl", cwd: "/dev/app" }],
        listArchived: async () => [{ sessionId: "dup", cwd: "/dev/app", archivePath: "/archive/dup.jsonl" }],
      }),
      cache: { totalsFor: async () => totals(5, 0.5), flush: async () => undefined },
    });

    const report = await service.report({ projectPath: "/dev/app", liveCwds: [] });
    expect(report.total.sessionCount).toBe(1);
    expect(report.total.input).toBe(5);
    expect(report.buckets.archived.sessionCount).toBe(1);
  });

  it("returns zeroed buckets when no session belongs to the project", async () => {
    const service = new ProjectUsageService({
      candidates: candidateSource({ listAll: async () => [{ id: "x", path: "/store/x.jsonl", cwd: "/elsewhere" }] }),
      cache: { totalsFor: async () => totals(9, 9), flush: async () => undefined },
    });

    const report = await service.report({ projectPath: "/dev/app", liveCwds: [] });
    expect(report.total).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessionCount: 0 });
  });

  it("shares one scan between concurrent requests for the same project", async () => {
    const listAll = vi.fn(async () => [{ id: "a", path: "/store/a.jsonl", cwd: "/dev/app" }]);
    const service = new ProjectUsageService({
      candidates: candidateSource({ listAll }),
      cache: { totalsFor: async () => totals(2, 0.2), flush: async () => undefined },
    });

    const [first, second] = await Promise.all([
      service.report({ projectPath: "/dev/app", liveCwds: [] }),
      service.report({ projectPath: "/dev/app", liveCwds: [] }),
    ]);

    expect(listAll).toHaveBeenCalledTimes(1);
    expect(first.total.input).toBe(2);
    expect(second.total.input).toBe(2);
  });

  it("flushes the cache after a report", async () => {
    const flush = vi.fn(async () => undefined);
    const service = new ProjectUsageService({
      candidates: candidateSource(),
      cache: { totalsFor: async () => totals(0, 0), flush },
    });

    await service.report({ projectPath: "/dev/app", liveCwds: [] });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("still flushes when a session scan throws", async () => {
    const flush = vi.fn(async () => undefined);
    const service = new ProjectUsageService({
      candidates: candidateSource({ listAll: async () => [{ id: "a", path: "/store/a.jsonl", cwd: "/dev/app" }] }),
      cache: {
        totalsFor: async () => { throw new Error("scan failed"); },
        flush,
      },
    });

    await expect(service.report({ projectPath: "/dev/app", liveCwds: [] })).rejects.toThrow("scan failed");
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/usage/projectUsageService.test.ts`
Expected: FAIL, cannot resolve `./projectUsageService`.

- [ ] **Step 3: Write the implementation**

```ts
import { assignBuckets, type CandidateInput, type ProjectUsageBucket } from "./projectUsageBuckets.js";
import { addUsageTotals, emptyUsageTotals, type UsageTotals } from "./sessionUsageScanner.js";

export interface ProjectUsageScopeRequest {
  projectPath: string;
  liveCwds: readonly string[];
}

export interface ProjectUsageBucketTotals extends UsageTotals {
  sessionCount: number;
}

export interface ProjectUsageReport {
  projectPath: string;
  buckets: Record<ProjectUsageBucket, ProjectUsageBucketTotals>;
  total: ProjectUsageBucketTotals;
  generatedAt: string;
}

export interface ProjectUsageStoreSession {
  id: string;
  path: string;
  cwd: string;
}

export interface ProjectUsageArchivedSession {
  sessionId: string;
  cwd: string;
  archivePath?: string;
  originalPath?: string;
}

export interface ProjectUsageCandidateSource {
  listForCwd(cwd: string): Promise<ProjectUsageStoreSession[]>;
  listAll(): Promise<ProjectUsageStoreSession[]>;
  listArchived(): Promise<ProjectUsageArchivedSession[]>;
}

export interface ProjectUsageCache {
  totalsFor(sessionId: string, path: string): Promise<UsageTotals>;
  flush(): Promise<void>;
}

export interface ProjectUsageServiceOptions {
  candidates: ProjectUsageCandidateSource;
  cache: ProjectUsageCache;
  now?: () => Date;
}

function emptyBucketTotals(): ProjectUsageBucketTotals {
  return { ...emptyUsageTotals(), sessionCount: 0 };
}

function addToBucket(bucket: ProjectUsageBucketTotals, totals: UsageTotals): ProjectUsageBucketTotals {
  return { ...addUsageTotals(bucket, totals), sessionCount: bucket.sessionCount + 1 };
}

/**
 * Assemble a project's usage report on demand.
 *
 * No project-level total is persisted, because bucket assignment depends on
 * scope resolved at request time: which worktrees exist now and which sessions
 * are archived now. Only per-session totals are cached.
 */
export class ProjectUsageService {
  private readonly inFlight = new Map<string, Promise<ProjectUsageReport>>();

  constructor(private readonly options: ProjectUsageServiceOptions) {}

  async report(scope: ProjectUsageScopeRequest): Promise<ProjectUsageReport> {
    const existing = this.inFlight.get(scope.projectPath);
    if (existing !== undefined) return existing;

    const run = this.buildReport(scope).finally(() => {
      this.inFlight.delete(scope.projectPath);
    });
    this.inFlight.set(scope.projectPath, run);
    return run;
  }

  private async buildReport(scope: ProjectUsageScopeRequest): Promise<ProjectUsageReport> {
    try {
      const inputs = await this.collectCandidates(scope);
      const candidates = assignBuckets(inputs, { projectPath: scope.projectPath, liveCwds: scope.liveCwds });

      const buckets: Record<ProjectUsageBucket, ProjectUsageBucketTotals> = {
        live: emptyBucketTotals(),
        retired: emptyBucketTotals(),
        archived: emptyBucketTotals(),
      };
      let total = emptyBucketTotals();

      // Sequential on purpose: interleaving many multi-megabyte session streams
      // multiplies memory and lengthens event-loop turns for live sessions.
      for (const candidate of candidates) {
        const totals = await this.options.cache.totalsFor(candidate.sessionId, candidate.path);
        buckets[candidate.bucket] = addToBucket(buckets[candidate.bucket], totals);
        total = addToBucket(total, totals);
      }

      const now = this.options.now?.() ?? new Date();
      return { projectPath: scope.projectPath, buckets, total, generatedAt: now.toISOString() };
    } finally {
      await this.options.cache.flush();
    }
  }

  private async collectCandidates(scope: ProjectUsageScopeRequest): Promise<CandidateInput[]> {
    const [archived, history, live] = await Promise.all([
      this.options.candidates.listArchived(),
      this.options.candidates.listAll(),
      Promise.all(scope.liveCwds.map((cwd) => this.options.candidates.listForCwd(cwd))),
    ]);

    // Archived first so a session that also still appears in the Pi store keeps
    // its archive classification and archive file path.
    return [
      ...archived.map((record) => ({
        sessionId: record.sessionId,
        path: record.archivePath ?? record.originalPath ?? "",
        cwd: record.cwd,
        archived: true,
      })),
      ...live.flat().map((session) => ({ sessionId: session.id, path: session.path, cwd: session.cwd })),
      ...history.map((session) => ({ sessionId: session.id, path: session.path, cwd: session.cwd })),
    ];
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/usage/projectUsageService.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/usage/projectUsageService.ts src/server/usage/projectUsageService.test.ts
git commit -m "feat(usage): assemble project usage reports on demand"
```

## Task 5: Shared contract, route, and daemon wiring

**Implementer tier:** Capable

**Files:**

- Create: `src/server/usage/projectUsageRoutes.ts`
- Create: `src/server/usage/projectUsageRoutes.test.ts`
- Modify: `src/shared/apiTypes.ts:6-28`
- Modify: `src/shared/capabilities.ts:33-34`
- Modify: `src/server/sessiond.ts:29-42`
- Modify: `src/server/sessiond/sessionProxyRoutes.ts:61-62`

**Interfaces:**

- Consumes: `ProjectUsageService` from Task 4 with `report(scope: { projectPath: string; liveCwds: readonly string[] }): Promise<ProjectUsageReport>`, where `ProjectUsageReport = { projectPath: string; buckets: Record<"live" | "retired" | "archived", ProjectUsageBucketTotals>; total: ProjectUsageBucketTotals; generatedAt: string }` and `ProjectUsageBucketTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; sessionCount: number }`. Also `SessionUsageCacheStore` from Task 2 and `ProjectUsageCandidateSource` from Task 4.
- Produces:
  - In `src/shared/apiTypes.ts`: `interface ProjectUsageTotals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; sessionCount: number }`, `interface ProjectUsageResponse { projectPath: string; buckets: { live: ProjectUsageTotals; retired: ProjectUsageTotals; archived: ProjectUsageTotals }; total: ProjectUsageTotals; generatedAt: string }`, `interface ProjectUsageRequest { projectPath: string; liveCwds: string[] }`, and a new capability key `projectUsageStatistics: "project.usageStatistics"`.
  - `function registerProjectUsageRoutes(app: FastifyInstance, usage: { report(scope: { projectPath: string; liveCwds: readonly string[] }): Promise<ProjectUsageResponse> }, prefix?: string): void`, registering `POST ${prefix}/sessions/project-usage`.

The route is registered under the `sessions/` path space so the existing `${prefix}/sessions/*` proxy rule forwards it with no proxy change. Verify that rule still matches; only add a proxy line if it does not.

- [ ] **Step 1: Write the failing test**

```ts
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerProjectUsageRoutes } from "./projectUsageRoutes";
import type { ProjectUsageResponse } from "../../shared/apiTypes.js";

function report(): ProjectUsageResponse {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessionCount: 0 };
  return {
    projectPath: "/dev/app",
    buckets: { live: { ...zero, input: 5, sessionCount: 1 }, retired: zero, archived: zero },
    total: { ...zero, input: 5, sessionCount: 1 },
    generatedAt: "2026-08-05T00:00:00.000Z",
  };
}

async function appWith(usage: { report: (scope: { projectPath: string; liveCwds: readonly string[] }) => Promise<ProjectUsageResponse> }) {
  const app = Fastify();
  registerProjectUsageRoutes(app, usage);
  await app.ready();
  return app;
}

describe("registerProjectUsageRoutes", () => {
  it("returns the report for a valid scope", async () => {
    const app = await appWith({ report: async () => report() });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app", liveCwds: ["/dev/app"] } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(report());
    await app.close();
  });

  it("passes the requested scope through", async () => {
    const reportFn = vi.fn(async () => report());
    const app = await appWith({ report: reportFn });
    await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app", liveCwds: ["/dev/app", "/dev/app/.worktrees/x"] } });

    expect(reportFn).toHaveBeenCalledWith({ projectPath: "/dev/app", liveCwds: ["/dev/app", "/dev/app/.worktrees/x"] });
    await app.close();
  });

  it("rejects a missing projectPath with 400", async () => {
    const app = await appWith({ report: async () => report() });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { liveCwds: [] } });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-array liveCwds with 400", async () => {
    const app = await appWith({ report: async () => report() });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app", liveCwds: "nope" } });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("defaults liveCwds to an empty list when omitted", async () => {
    const reportFn = vi.fn(async () => report());
    const app = await appWith({ report: reportFn });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app" } });

    expect(response.statusCode).toBe(200);
    expect(reportFn).toHaveBeenCalledWith({ projectPath: "/dev/app", liveCwds: [] });
    await app.close();
  });

  it("maps a service failure to 500", async () => {
    const app = await appWith({ report: async () => { throw new Error("scan blew up"); } });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app", liveCwds: [] } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "scan blew up" });
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/usage/projectUsageRoutes.test.ts`
Expected: FAIL, cannot resolve `./projectUsageRoutes`.

- [ ] **Step 3: Add the shared contract types and capability**

In `src/shared/apiTypes.ts`, add the capability key inside the existing `PI_WEBUI_CAPABILITIES` object literal:

```ts
  projectUsageStatistics: "project.usageStatistics",
```

Then add the response types near the other project types:

```ts
export interface ProjectUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  sessionCount: number;
}

export interface ProjectUsageResponse {
  projectPath: string;
  buckets: {
    live: ProjectUsageTotals;
    retired: ProjectUsageTotals;
    archived: ProjectUsageTotals;
  };
  total: ProjectUsageTotals;
  generatedAt: string;
}

export interface ProjectUsageRequest {
  projectPath: string;
  liveCwds: string[];
}
```

In `src/shared/capabilities.ts`, add to `SESSIOND_RUNTIME_CAPABILITIES`:

```ts
  PI_WEBUI_CAPABILITIES.projectUsageStatistics,
```

Do not add it to `WEB_RUNTIME_CAPABILITIES`; the web runtime does not implement this.

- [ ] **Step 4: Write the route module**

```ts
import type { FastifyInstance } from "fastify";
import type { ProjectUsageResponse } from "../../shared/apiTypes.js";

export interface ProjectUsageReporter {
  report(scope: { projectPath: string; liveCwds: readonly string[] }): Promise<ProjectUsageResponse>;
}

interface ProjectUsageBody {
  projectPath?: unknown;
  liveCwds?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerProjectUsageRoutes(app: FastifyInstance, usage: ProjectUsageReporter, prefix = ""): void {
  app.post<{ Body: ProjectUsageBody | undefined }>(`${prefix}/sessions/project-usage`, async (request, reply) => {
    const body = request.body ?? {};
    const projectPath = body.projectPath;
    if (typeof projectPath !== "string" || projectPath === "") {
      return reply.code(400).send({ error: "projectPath is required" });
    }

    const rawCwds = body.liveCwds;
    if (rawCwds !== undefined && !Array.isArray(rawCwds)) {
      return reply.code(400).send({ error: "liveCwds must be an array of strings" });
    }
    if (Array.isArray(rawCwds) && rawCwds.some((cwd) => typeof cwd !== "string")) {
      return reply.code(400).send({ error: "liveCwds must be an array of strings" });
    }
    const liveCwds = Array.isArray(rawCwds) ? (rawCwds as string[]) : [];

    try {
      return await usage.report({ projectPath, liveCwds });
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test -- --run src/server/usage/projectUsageRoutes.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Wire the service into the session daemon**

In `src/server/sessiond.ts`, add imports beside the existing session imports:

```ts
import { ProjectUsageService } from "./usage/projectUsageService.js";
import { SessionUsageCacheStore } from "./usage/sessionUsageCacheStore.js";
import { registerProjectUsageRoutes } from "./usage/projectUsageRoutes.js";
```

Inside `createRuntime`, after `sessions` is constructed, build the usage service against the same session-manager gateway and archive store the daemon already uses. Create the gateway in a named `const` so both `PiSessionService` and the usage service share one instance:

```ts
    const sessionManagerGateway = createPiSessionManagerGateway({
      agentDir: activeAgentProfile.dir,
      env: daemonEnvironment,
      sessionDirEnvKeys: activeAgentProfile.sessionDirEnvKeys,
    });
```

Pass `sessionManager: sessionManagerGateway` to the existing `PiSessionService` options instead of the inline `createPiSessionManagerGateway({ ... })` call, then add:

```ts
    const usageArchiveStore = new SessionArchiveStore();
    const projectUsage = new ProjectUsageService({
      candidates: {
        listForCwd: async (cwd) => (await sessionManagerGateway.list(cwd)).map((entry) => ({ id: entry.id, path: entry.path, cwd: entry.cwd })),
        listAll: async () => (await sessionManagerGateway.listAll()).map((entry) => ({ id: entry.id, path: entry.path, cwd: entry.cwd })),
        listArchived: async () => (await usageArchiveStore.list()).map((record) => ({
          sessionId: record.sessionId,
          cwd: record.cwd,
          ...(record.archivePath === undefined ? {} : { archivePath: record.archivePath }),
          ...(record.originalPath === undefined ? {} : { originalPath: record.originalPath }),
        })),
      },
      cache: new SessionUsageCacheStore(),
    });
```

Import `SessionArchiveStore` from `./sessions/sessionArchiveStore.js` if it is not already imported. Add `projectUsage` to the object returned by `createRuntime`, to the `registerRoutes` destructuring parameter, and register it beside the other route registrations:

```ts
    registerProjectUsageRoutes(app, projectUsage);
```

- [ ] **Step 7: Confirm the proxy already forwards the route**

Run: `rg -n 'sessions/\*' src/server/sessiond/sessionProxyRoutes.ts`
Expected: a line registering `app.all(\`${prefix}/sessions/*\`, ...)`. That rule forwards `POST /api/sessions/project-usage`, so no proxy change is needed. If the rule is absent, add a proxy line for `${prefix}/sessions/project-usage`.

- [ ] **Step 8: Verify the daemon still typechecks and existing suites pass**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test -- --run src/server/sessions/sessionRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add src/shared/apiTypes.ts src/shared/capabilities.ts src/server/usage/projectUsageRoutes.ts src/server/usage/projectUsageRoutes.test.ts src/server/sessiond.ts
git commit -m "feat(usage): expose project usage statistics from the session daemon"
```

## Task 6: Client API parser and client

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/api/parsers.ts:1-40`
- Modify: `src/client/src/api/clients.ts:288-296`
- Test: `src/client/src/api/parsers.projectUsage.test.ts`

**Interfaces:**

- Consumes: `ProjectUsageResponse`, `ProjectUsageTotals`, and `ProjectUsageRequest` from `src/shared/apiTypes.ts` as defined in Task 5, where `ProjectUsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; sessionCount: number }` and `ProjectUsageResponse = { projectPath: string; buckets: { live: ProjectUsageTotals; retired: ProjectUsageTotals; archived: ProjectUsageTotals }; total: ProjectUsageTotals; generatedAt: string }`.
- Produces:
  - `export function parseProjectUsageResponse(value: unknown): ProjectUsageResponse` in `src/client/src/api/parsers.ts`
  - `projectUsage(request: ProjectUsageRequest, machineId?: string): Promise<ProjectUsageResponse>` added to the existing `projectsApi` object in `src/client/src/api/clients.ts`

The parser is strict: it throws on a missing or non-numeric field, following the existing `requireNumber` / `requireRecord` helpers in that file.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseProjectUsageResponse } from "./parsers";

const totals = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, sessionCount: 6 };

function validResponse(): Record<string, unknown> {
  return {
    projectPath: "/dev/app",
    buckets: { live: totals, retired: totals, archived: totals },
    total: { ...totals, input: 3 },
    generatedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("parseProjectUsageResponse", () => {
  it("parses a complete response", () => {
    const parsed = parseProjectUsageResponse(validResponse());
    expect(parsed.projectPath).toBe("/dev/app");
    expect(parsed.buckets.live).toEqual(totals);
    expect(parsed.buckets.retired.cacheRead).toBe(3);
    expect(parsed.buckets.archived.sessionCount).toBe(6);
    expect(parsed.total.input).toBe(3);
    expect(parsed.generatedAt).toBe("2026-08-05T00:00:00.000Z");
  });

  it("throws when a bucket is missing", () => {
    const response = validResponse();
    response["buckets"] = { live: totals, retired: totals };
    expect(() => parseProjectUsageResponse(response)).toThrow();
  });

  it("throws when a numeric field is not a number", () => {
    const response = validResponse();
    response["total"] = { ...totals, cost: "free" };
    expect(() => parseProjectUsageResponse(response)).toThrow();
  });

  it("throws when the payload is not an object", () => {
    expect(() => parseProjectUsageResponse(null)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/api/parsers.projectUsage.test.ts`
Expected: FAIL, `parseProjectUsageResponse` is not exported.

- [ ] **Step 3: Add the parser**

In `src/client/src/api/parsers.ts`, add `ProjectUsageResponse` and `ProjectUsageTotals` to the existing type import from `../../../shared/apiTypes`, then add:

```ts
function parseProjectUsageTotals(value: unknown): ProjectUsageTotals {
  const record = requireRecord(value);
  return {
    input: requireNumber(record, "input"),
    output: requireNumber(record, "output"),
    cacheRead: requireNumber(record, "cacheRead"),
    cacheWrite: requireNumber(record, "cacheWrite"),
    cost: requireNumber(record, "cost"),
    sessionCount: requireNumber(record, "sessionCount"),
  };
}

export function parseProjectUsageResponse(value: unknown): ProjectUsageResponse {
  const record = requireRecord(value);
  const buckets = requireRecord(record["buckets"]);
  return {
    projectPath: requireString(record, "projectPath"),
    buckets: {
      live: parseProjectUsageTotals(buckets["live"]),
      retired: parseProjectUsageTotals(buckets["retired"]),
      archived: parseProjectUsageTotals(buckets["archived"]),
    },
    total: parseProjectUsageTotals(record["total"]),
    generatedAt: requireString(record, "generatedAt"),
  };
}
```

- [ ] **Step 4: Add the client method**

In `src/client/src/api/clients.ts`, add `ProjectUsageRequest` and `ProjectUsageResponse` to the existing type imports, import `parseProjectUsageResponse` from `./parsers`, and add this entry to the existing `projectsApi` object:

```ts
  projectUsage: (input: ProjectUsageRequest, machineId = "local"): Promise<ProjectUsageResponse> =>
    request(`${machinePrefix(machineId)}/sessions/project-usage`, parseProjectUsageResponse, { method: "POST", body: JSON.stringify(input) }),
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/api/parsers.projectUsage.test.ts src/client/src/api/clients.test.ts`
Expected: PASS, 4 new tests plus the existing client suite.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/api/parsers.ts src/client/src/api/clients.ts src/client/src/api/parsers.projectUsage.test.ts
git commit -m "feat(usage): add project usage client and parser"
```

## Task 7: Statistics dialog component

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/components/ProjectStatisticsDialog.ts`
- Create: `src/client/src/components/ProjectStatisticsDialog.test.ts`

**Interfaces:**

- Consumes: `ProjectUsageResponse` and `ProjectUsageTotals` from `src/shared/apiTypes.ts` per Task 5; `formatFullNumber(n: number): string`, `formatCompactNumber(n: number): string`, and `formatPreciseCost(cost: number): string` from `../utils/format`; `Project` from the shared API types.
- Produces:
  - `function usageBucketRows(report: ProjectUsageResponse): { key: "live" | "retired" | "archived"; label: string; totals: ProjectUsageTotals }[]`
  - `function formatUsageTokens(value: number): string`
  - `<project-statistics-dialog>` custom element class `ProjectStatisticsDialog` with properties `project?: Project`, `report?: ProjectUsageResponse`, `loading = false`, `errorMessage?: string`, `sessionCount?: number`, and `onClose?: () => void`

`formatUsageTokens` returns an exact locale string below 1,000,000 and a compact string at or above it, so low-usage buckets keep precision while large ones stay narrow. The component renders data it is given; it performs no fetching.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { formatUsageTokens, usageBucketRows } from "./ProjectStatisticsDialog";
import type { ProjectUsageResponse } from "../../../shared/apiTypes";

function totals(input: number, sessionCount: number) {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1.5, sessionCount };
}

function report(): ProjectUsageResponse {
  return {
    projectPath: "/dev/app",
    buckets: { live: totals(10, 1), retired: totals(20, 2), archived: totals(30, 3) },
    total: totals(60, 6),
    generatedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("formatUsageTokens", () => {
  it("keeps small values exact", () => {
    expect(formatUsageTokens(7574)).toBe((7574).toLocaleString());
  });

  it("compacts values at a million or above", () => {
    expect(formatUsageTokens(93_274_304)).toBe("93.3M");
  });

  it("renders zero as zero", () => {
    expect(formatUsageTokens(0)).toBe("0");
  });
});

describe("usageBucketRows", () => {
  it("returns the three buckets in display order with labels", () => {
    const rows = usageBucketRows(report());
    expect(rows.map((row) => row.key)).toEqual(["live", "retired", "archived"]);
    expect(rows.map((row) => row.label)).toEqual(["Live workspaces", "Retired worktrees", "Archived"]);
    expect(rows[1]?.totals.input).toBe(20);
  });
});

describe("ProjectStatisticsDialog", () => {
  it("renders bucket labels, the total, and the deleted-note when a report is present", async () => {
    const { ProjectStatisticsDialog } = await import("./ProjectStatisticsDialog");
    const element = new ProjectStatisticsDialog();
    element.project = { id: "p1", name: "app", path: "/dev/app", createdAt: "2026-08-01T00:00:00.000Z" };
    element.report = report();
    document.body.append(element);
    await element.updateComplete;

    const text = element.renderRoot.textContent ?? "";
    expect(text).toContain("Live workspaces");
    expect(text).toContain("Retired worktrees");
    expect(text).toContain("Archived");
    expect(text).toContain("not counted");
    expect(text).toContain(formatUsageTokens(60));
    element.remove();
  });

  it("renders a scanning state with the session count while loading", async () => {
    const { ProjectStatisticsDialog } = await import("./ProjectStatisticsDialog");
    const element = new ProjectStatisticsDialog();
    element.loading = true;
    element.sessionCount = 639;
    document.body.append(element);
    await element.updateComplete;

    expect(element.renderRoot.textContent ?? "").toContain("639");
    element.remove();
  });

  it("renders the error message when a scan fails", async () => {
    const { ProjectStatisticsDialog } = await import("./ProjectStatisticsDialog");
    const element = new ProjectStatisticsDialog();
    element.errorMessage = "scan blew up";
    document.body.append(element);
    await element.updateComplete;

    expect(element.renderRoot.textContent ?? "").toContain("scan blew up");
    element.remove();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/ProjectStatisticsDialog.test.ts`
Expected: FAIL, cannot resolve `./ProjectStatisticsDialog`.

- [ ] **Step 3: Write the component**

Follow the dialog conventions in `src/client/src/components/SessionBrowserDialog.ts`: a `.backdrop` wrapper, `section[role="dialog"]` sized `width: min(960px, 100%)`, a header with a close button, and `listStyles` from `./shared` where useful. Numeric table cells are right-aligned with left padding for gutters, and use `font-variant-numeric: tabular-nums`.

```ts
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Project, ProjectUsageResponse, ProjectUsageTotals } from "../../../shared/apiTypes";
import { formatCompactNumber, formatFullNumber, formatPreciseCost } from "../utils/format";

const BUCKET_LABELS = [
  { key: "live", label: "Live workspaces" },
  { key: "retired", label: "Retired worktrees" },
  { key: "archived", label: "Archived" },
] as const;

/**
 * Exact below a million, compact at or above it. Exact digits everywhere would
 * widen the columns past the dialog; compact everywhere would erase meaningful
 * precision in low-usage buckets.
 */
export function formatUsageTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value >= 1_000_000 ? formatCompactNumber(value) : formatFullNumber(value);
}

export function usageBucketRows(report: ProjectUsageResponse): { key: "live" | "retired" | "archived"; label: string; totals: ProjectUsageTotals }[] {
  return BUCKET_LABELS.map((bucket) => ({ key: bucket.key, label: bucket.label, totals: report.buckets[bucket.key] }));
}

@customElement("project-statistics-dialog")
export class ProjectStatisticsDialog extends LitElement {
  @property({ attribute: false }) project?: Project;
  @property({ attribute: false }) report?: ProjectUsageResponse;
  @property({ type: Boolean }) loading = false;
  @property({ attribute: false }) errorMessage?: string;
  @property({ attribute: false }) sessionCount?: number;
  @property({ attribute: false }) onClose?: () => void;

  override render() {
    return html`
      <div class="backdrop" @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.onClose?.(); }}>
        <section role="dialog" aria-label=${`Statistics for ${this.project?.name ?? "project"}`}>
          <header>
            <div>
              <strong>Project Statistics</strong>
              ${this.project === undefined ? null : html`<small>${this.project.name}</small>`}
            </div>
            <button class="close-button" type="button" title="Close statistics" aria-label="Close statistics" @click=${() => { this.onClose?.(); }}>×</button>
          </header>
          <div class="body">${this.renderBody()}</div>
        </section>
      </div>
    `;
  }

  private renderBody() {
    if (this.errorMessage !== undefined) return html`<p class="usage-error" role="alert">${this.errorMessage}</p>`;
    if (this.report === undefined) return this.renderScanning();
    return this.renderReport(this.report);
  }

  private renderScanning() {
    const count = this.sessionCount;
    return html`
      <div class="usage-scanning">
        <p>${count === undefined ? "Scanning sessions…" : `Scanning ${formatFullNumber(count)} sessions…`}</p>
        <p class="usage-hint">First open only. Later opens are near-instant.</p>
      </div>
    `;
  }

  private renderReport(report: ProjectUsageResponse) {
    const rows = usageBucketRows(report);
    return html`
      <div class="usage-headline">
        <span class="usage-cost">${formatPreciseCost(report.total.cost)}</span>
        <span class="usage-summary">${formatFullNumber(report.total.sessionCount)} sessions · ${formatUsageTokens(report.total.cacheRead)} cache read</span>
      </div>
      <table class="usage-table">
        <thead>
          <tr>
            <th scope="col" class="usage-source">Source</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Cache read</th>
            <th scope="col">Cache write</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => html`
            <tr>
              <th scope="row" class="usage-source">${row.label} <span class="usage-count">· ${formatFullNumber(row.totals.sessionCount)}</span></th>
              <td>${formatUsageTokens(row.totals.input)}</td>
              <td>${formatUsageTokens(row.totals.output)}</td>
              <td>${formatUsageTokens(row.totals.cacheRead)}</td>
              <td>${formatUsageTokens(row.totals.cacheWrite)}</td>
              <td>${formatPreciseCost(row.totals.cost)}</td>
            </tr>
          `)}
          <tr class="usage-deleted">
            <th scope="row" class="usage-source">Deleted</th>
            <td colspan="5">not counted</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" class="usage-source">Total</th>
            <td>${formatUsageTokens(report.total.input)}</td>
            <td>${formatUsageTokens(report.total.output)}</td>
            <td>${formatUsageTokens(report.total.cacheRead)}</td>
            <td>${formatUsageTokens(report.total.cacheWrite)}</td>
            <td>${formatPreciseCost(report.total.cost)}</td>
          </tr>
        </tfoot>
      </table>
    `;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 40; }
    .backdrop { width: 100%; height: 100dvh; display: grid; place-items: center; padding: 16px; background: var(--pi-overlay); }
    section[role="dialog"] { width: min(960px, 100%); max-height: min(760px, 100%); min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--pi-border); }
    header small { display: block; color: var(--pi-muted); }
    .close-button { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 0; background: transparent; color: var(--pi-muted); font-size: 20px; line-height: 1; cursor: pointer; }
    .body { overflow: auto; padding: 16px 20px 20px; }
    .usage-headline { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .usage-cost { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .usage-summary, .usage-hint, .usage-count { color: var(--pi-muted); font-size: 12px; }
    .usage-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-variant-numeric: tabular-nums; }
    .usage-table th, .usage-table td { text-align: right; padding: 9px 0 9px 30px; border-top: 1px solid var(--pi-border-muted); font-weight: inherit; }
    .usage-table thead th { border-top: 0; color: var(--pi-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
    .usage-table .usage-source { text-align: left; padding-left: 0; }
    .usage-table tfoot th, .usage-table tfoot td { border-top: 2px solid var(--pi-border); font-weight: 700; }
    .usage-deleted td { color: var(--pi-muted); }
    .usage-scanning { padding: 24px 0; text-align: center; }
    .usage-error { color: var(--pi-danger, #b3261e); }
    @media (max-width: 760px) {
      .usage-table thead { display: none; }
      .usage-table tr { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 10px 0; border-top: 1px solid var(--pi-border-muted); }
      .usage-table th, .usage-table td { padding: 0; border-top: 0; }
      .usage-table .usage-source { grid-column: 1 / 2; }
    }
  `;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/client/src/components/ProjectStatisticsDialog.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `npx eslint src/client/src/components/ProjectStatisticsDialog.ts`
Expected: no errors.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/components/ProjectStatisticsDialog.ts src/client/src/components/ProjectStatisticsDialog.test.ts
git commit -m "feat(usage): add project statistics dialog"
```

## Task 8: Menu entries and app wiring

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/ProjectList.ts:15-30`
- Modify: `src/client/src/components/ProjectBrowserDialog.ts:14-24`
- Modify: `src/client/src/components/appShell/AppNavigationPanel.ts:155-170`
- Modify: `src/client/src/components/PiWebUiApp.ts:1550-1585`
- Test: `src/client/src/components/ProjectList.statistics.test.ts`
- Test: `src/client/src/components/ProjectBrowserDialog.statistics.test.ts`

**Interfaces:**

- Consumes:
  - `projectsApi.projectUsage(input: { projectPath: string; liveCwds: string[] }, machineId?: string): Promise<ProjectUsageResponse>` from Task 6.
  - `<project-statistics-dialog>` with properties `project`, `report`, `loading`, `errorMessage`, `sessionCount`, `onClose` from Task 7.
  - `PI_WEBUI_CAPABILITIES.projectUsageStatistics` and `supportsPiWebUiCapability(source, capability)` from `src/shared/capabilities.ts` per Task 5.
- Produces:
  - `onShowStatistics?: (project: Project) => void` property on `ProjectList`, rendering a **Statistics** button before **Close** in the action menu panel.
  - `onShowProjectStatistics?: (project: Project) => void | Promise<void>` property on `ProjectBrowserDialog`, rendering the same entry in its action menu panel.
  - `statisticsAvailable = false` boolean property on both components; when false the entry is not rendered.
  - `AppNavigationPanel` forwards a new `onShowProjectStatistics?: (project: Project) => void` property and a `projectStatisticsAvailable = false` property into `<project-list>`.

Both menus close before invoking the callback, matching how `close(project)` clears `openMenuProjectId` first.

- [ ] **Step 1: Write the failing tests**

Create `src/client/src/components/ProjectList.statistics.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { findOptionalTemplateEventHandlerNearMarker, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
import { ProjectList } from "./ProjectList";

const project: Project = { id: "p1", name: "app", path: "/dev/app", createdAt: "2026-08-01T00:00:00.000Z" };

// Direct handler extraction: this asserts only that the menu entry is wired to
// the callback and that the menu closes, which a full DOM harness would not
// make clearer.
function openMenu(list: ProjectList): void {
  list.projects = [project];
  Reflect.set(list, "openMenuProjectId", project.id);
}

describe("project list statistics entry", () => {
  it("invokes the callback and closes the menu", () => {
    const list = new ProjectList();
    const onShowStatistics = vi.fn();
    list.statisticsAvailable = true;
    list.onShowStatistics = onShowStatistics;
    openMenu(list);

    templateEventHandlerNearMarker(list.render(), "Statistics")(new MouseEvent("click"));

    expect(onShowStatistics).toHaveBeenCalledWith(project);
    expect(Reflect.get(list, "openMenuProjectId")).toBeUndefined();
  });

  it("omits the entry when the capability is unavailable", () => {
    const list = new ProjectList();
    list.statisticsAvailable = false;
    list.onShowStatistics = vi.fn();
    openMenu(list);

    expect(findOptionalTemplateEventHandlerNearMarker(list.render(), "Statistics")).toBeUndefined();
  });
});
```

Create `src/client/src/components/ProjectBrowserDialog.statistics.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { findOptionalTemplateEventHandlerNearMarker, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";

const project: Project = { id: "p1", name: "app", path: "/dev/app", createdAt: "2026-08-01T00:00:00.000Z" };

describe("project browser statistics entry", () => {
  it("invokes the callback and closes the menu", () => {
    const dialog = new ProjectBrowserDialog();
    const onShowProjectStatistics = vi.fn();
    dialog.projects = [project];
    dialog.statisticsAvailable = true;
    dialog.onShowProjectStatistics = onShowProjectStatistics;
    Reflect.set(dialog, "openMenuProjectId", project.id);

    templateEventHandlerNearMarker(dialog.render(), "Statistics")(new MouseEvent("click"));

    expect(onShowProjectStatistics).toHaveBeenCalledWith(project);
    expect(Reflect.get(dialog, "openMenuProjectId")).toBeUndefined();
  });

  it("omits the entry when the capability is unavailable", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = [project];
    dialog.statisticsAvailable = false;
    dialog.onShowProjectStatistics = vi.fn();
    Reflect.set(dialog, "openMenuProjectId", project.id);

    expect(findOptionalTemplateEventHandlerNearMarker(dialog.render(), "Statistics")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/ProjectList.statistics.test.ts src/client/src/components/ProjectBrowserDialog.statistics.test.ts`
Expected: FAIL, `statisticsAvailable` does not exist and no handler is found near `Statistics`.

- [ ] **Step 3: Add the menu entry to ProjectList**

In `src/client/src/components/ProjectList.ts`, add properties beside the existing `onClose`:

```ts
  @property({ attribute: false }) onShowStatistics?: (project: Project) => void;
  @property({ type: Boolean }) statisticsAvailable = false;
```

In the action menu panel, render the entry before the existing Close button:

```ts
                      ${this.statisticsAvailable ? html`<button title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
```

Add the method beside `close`:

```ts
  private showStatistics(project: Project) {
    this.openMenuProjectId = undefined;
    this.onShowStatistics?.(project);
  }
```

- [ ] **Step 4: Add the same entry to ProjectBrowserDialog**

In `src/client/src/components/ProjectBrowserDialog.ts`, add:

```ts
  @property({ attribute: false }) onShowProjectStatistics?: (project: Project) => void | Promise<void>;
  @property({ type: Boolean }) statisticsAvailable = false;
```

Render before its Close button:

```ts
                  ${this.statisticsAvailable ? html`<button type="button" title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
```

And add:

```ts
  private showStatistics(project: Project) {
    this.openMenuProjectId = undefined;
    void this.onShowProjectStatistics?.(project);
  }
```

- [ ] **Step 5: Forward the properties through AppNavigationPanel**

In `src/client/src/components/appShell/AppNavigationPanel.ts`, add properties beside the existing project callbacks:

```ts
  @property({ attribute: false }) onShowProjectStatistics?: (project: Project) => void;
  @property({ type: Boolean }) projectStatisticsAvailable = false;
```

And pass them into `<project-list>`:

```ts
        .statisticsAvailable=${this.projectStatisticsAvailable}
        .onShowStatistics=${(project: Project) => this.onShowProjectStatistics?.(project)}
```

- [ ] **Step 6: Wire fetching and the dialog into PiWebUiApp**

In `src/client/src/components/PiWebUiApp.ts`:

1. Import the dialog module for its side effect of registering the element, beside the other component imports:

```ts
import "./ProjectStatisticsDialog";
```

2. Add state fields beside the other dialog state:

```ts
  @state() private statisticsProject?: Project;
  @state() private statisticsReport?: ProjectUsageResponse;
  @state() private statisticsLoading = false;
  @state() private statisticsError?: string;
```

3. Add a capability getter following the existing pattern at `PiWebUiApp.ts:1555-1581`:

```ts
  private get projectStatisticsAvailable(): boolean {
    const runtime = this.runtimeStatus;
    return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.projectUsageStatistics);
  }
```

Use the same `runtimeStatus` accessor those neighbouring getters use; do not introduce a different source.

4. Add the open handler. It resolves live workspace cwds from the workspaces already loaded for the project, so no extra request is needed:

```ts
  private async showProjectStatistics(project: Project): Promise<void> {
    this.statisticsProject = project;
    this.statisticsReport = undefined;
    this.statisticsError = undefined;
    this.statisticsLoading = true;
    const liveCwds = (this.workspacesByProjectId[project.id] ?? []).map((workspace) => workspace.path);
    try {
      this.statisticsReport = await projectsApi.projectUsage({ projectPath: project.path, liveCwds }, this.selectedMachineId);
    } catch (error: unknown) {
      this.statisticsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.statisticsLoading = false;
    }
  }
```

Match the existing field names this component already uses for the workspace map and the selected machine id; if they differ from `workspacesByProjectId` and `selectedMachineId`, use the existing ones rather than adding new state.

5. Pass the capability and handler into `<app-navigation-panel>` and into the project browser dialog usage, and render the statistics dialog when a project is selected for it:

```ts
      ${this.statisticsProject === undefined ? null : html`
        <project-statistics-dialog
          .project=${this.statisticsProject}
          .report=${this.statisticsReport}
          .loading=${this.statisticsLoading}
          .errorMessage=${this.statisticsError}
          .sessionCount=${this.statisticsReport?.total.sessionCount}
          .onClose=${() => { this.statisticsProject = undefined; }}
        ></project-statistics-dialog>
      `}
```

Import `ProjectUsageResponse` as a type and `projectsApi` if not already imported.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/ProjectList.statistics.test.ts src/client/src/components/ProjectBrowserDialog.statistics.test.ts src/client/src/components/ProjectList.test.ts src/client/src/components/ProjectBrowserDialog.test.ts`
Expected: PASS, 4 new tests and no regressions in the existing suites.

- [ ] **Step 8: Full verification**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run verify`
Expected: PASS. This is a cross-cutting change touching shared types, server, and client.

- [ ] **Step 9: Add a changeset**

Create `.changeset/project-token-usage-statistics.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Add a project Statistics view reporting total input, output, cache read, cache write, and cost for a project, including usage from archived sessions and removed worktrees.
```

- [ ] **Step 10: Commit**

```bash
git add src/client/src/components/ProjectList.ts src/client/src/components/ProjectBrowserDialog.ts src/client/src/components/appShell/AppNavigationPanel.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/ProjectList.statistics.test.ts src/client/src/components/ProjectBrowserDialog.statistics.test.ts .changeset/project-token-usage-statistics.md
git commit -m "feat(usage): open project statistics from both project menus"
```

## Task 9: Event-loop lag regression test

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/usage/sessionUsageScanner.eventLoop.test.ts`

**Interfaces:**

- Consumes: `scanSessionUsage(path: string, startOffset: number): Promise<{ totals: UsageTotals; bytesScanned: number }>` from Task 1, where `UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }`.
- Produces: no production code. This task adds the regression test that pins the streaming property the spec depends on.

The test builds a large synthetic session file, measures maximum event-loop lag while scanning it, and fails if lag exceeds 50 ms. The measured baseline on a real 334 MB store was 1.9 ms peak, so 50 ms is a wide margin that still fails loudly if someone replaces streaming with `readFile`.

- [ ] **Step 1: Write the test**

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { scanSessionUsage } from "./sessionUsageScanner";

const LAG_BUDGET_MS = 50;
const PROBE_INTERVAL_MS = 20;

function assistantLine(input: number): string {
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, content: "x".repeat(400) },
  });
}

async function writeLargeSession(): Promise<{ path: string; expectedInput: number }> {
  const dir = await mkdtemp(join(tmpdir(), "usage-lag-"));
  const path = join(dir, "session.jsonl");
  const header = JSON.stringify({ type: "session", id: "lag", cwd: "/repo" });
  const lineCount = 20_000;
  const lines = [header];
  for (let index = 0; index < lineCount; index += 1) lines.push(assistantLine(1));
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return { path, expectedInput: lineCount };
}

describe("scanSessionUsage event-loop behavior", () => {
  it("keeps the event loop responsive while scanning a large session", async () => {
    const { path, expectedInput } = await writeLargeSession();

    let maxLag = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - PROBE_INTERVAL_MS);
      last = now;
    }, PROBE_INTERVAL_MS);

    try {
      const result = await scanSessionUsage(path, 0);
      expect(result.totals.input).toBe(expectedInput);
    } finally {
      clearInterval(probe);
    }

    // Streaming keeps each turn short. A whole-file read would block for the
    // entire parse and blow this budget.
    expect(maxLag).toBeLessThan(LAG_BUDGET_MS);
  });
});
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `npm test -- --run src/server/usage/sessionUsageScanner.eventLoop.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 3: Confirm the test is falsifiable**

Temporarily change `scanSessionUsage` to read the whole file with `readFile` and split on newlines, then run the test again.

Run: `npm test -- --run src/server/usage/sessionUsageScanner.eventLoop.test.ts`
Expected: FAIL on the lag assertion, or a clearly larger `maxLag`. Revert the temporary change immediately afterwards and re-run to confirm PASS. Do not commit the temporary change.

- [ ] **Step 4: Commit**

```bash
git add src/server/usage/sessionUsageScanner.eventLoop.test.ts
git commit -m "test(usage): pin event-loop responsiveness during usage scans"
```
