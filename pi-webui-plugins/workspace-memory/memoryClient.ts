import type { MemoryEntry } from "./memoryData.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseMemoryEntry(value: unknown): MemoryEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  const content = value["content"];
  if (typeof id !== "string" || typeof content !== "string") return undefined;

  const entry: MemoryEntry = { id, content };

  const category = value["category"];
  if (typeof category === "string") entry.category = category;

  const created = value["created"];
  if (typeof created === "string") entry.created = created;

  const last = value["last"];
  if (typeof last === "string") entry.last = last;

  const failureReason = value["failureReason"];
  if (typeof failureReason === "string") entry.failureReason = failureReason;

  return entry;
}

function parseEntries(data: unknown): MemoryEntry[] {
  if (!isRecord(data)) throw new Error("Invalid memory API response");
  const entries = data["entries"];
  if (!Array.isArray(entries)) throw new Error("Invalid memory API response");

  const result: MemoryEntry[] = [];
  for (const raw of entries) {
    const parsed = parseMemoryEntry(raw);
    if (parsed !== undefined) result.push(parsed);
  }
  return result;
}

export async function fetchGlobalMemories(): Promise<MemoryEntry[]> {
  const response = await fetch("api/agent-memory/global");
  if (!response.ok) {
    throw new Error("Failed to load global memories: " + String(response.status));
  }
  return parseEntries(await response.json());
}

export async function fetchProjectMemories(projectPath: string): Promise<MemoryEntry[]> {
  const params = new URLSearchParams({ projectPath });
  const response = await fetch("api/agent-memory/project?" + String(params));
  if (!response.ok) {
    throw new Error("Failed to load project memories: " + String(response.status));
  }
  return parseEntries(await response.json());
}
