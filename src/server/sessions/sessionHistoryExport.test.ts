import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportSessionHistoryHtml } from "./sessionHistoryExport.js";

/** Deep enough that recursive tree preparation used to exhaust the browser stack. */
const ENTRY_COUNT = 5_000;

function linearSession(): string {
  const header = {
    type: "session",
    version: 3,
    id: "history-export-fixture",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
  };
  const lines = [JSON.stringify(header)];
  let parentId: string | null = null;
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    const id = `entry-${String(index)}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `message ${String(index)}` }],
        },
      }),
    );
    parentId = id;
  }
  return `${lines.join("\n")}\n`;
}

/** The viewer embeds its transcript as base64 JSON in a script element. */
function exportedEntryIds(html: string): string[] {
  const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html);
  const encoded = match?.[1];
  if (encoded === undefined) throw new Error("exported HTML carries no session data");
  const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || !("entries" in parsed)) {
    throw new Error("exported session data has no entries");
  }
  const { entries } = parsed;
  if (!Array.isArray(entries)) throw new Error("exported session entries are not a list");
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("id" in entry) || typeof entry.id !== "string") {
      throw new Error("exported session entry has no id");
    }
    return entry.id;
  });
}

describe("exportSessionHistoryHtml", () => {
  it("keeps every entry of a long linear history in the exported viewer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-webui-history-test-"));
    const sessionFile = join(directory, "session.jsonl");
    try {
      await writeFile(sessionFile, linearSession(), "utf8");

      const ids = exportedEntryIds(await exportSessionHistoryHtml(sessionFile));

      expect(ids).toHaveLength(ENTRY_COUNT);
      expect(ids[0]).toBe("entry-0");
      expect(ids.at(-1)).toBe(`entry-${String(ENTRY_COUNT - 1)}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
