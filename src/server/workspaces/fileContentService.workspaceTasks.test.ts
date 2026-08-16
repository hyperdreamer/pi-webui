import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_WORKSPACE_FILE_BYTES } from "../../shared/workspaceFiles.js";
import {
  readWorkspaceFileBytesFromTarget,
  readWorkspaceFileRaw,
  type WorkspaceFileRawReadOperations,
} from "./fileContentService.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./fileContentService.testSupport.js";

afterEach(async () => {
  await cleanupTempWorkspaces();
});

describe("readWorkspaceFileRaw", () => {
  it("returns complete bounded bytes for valid UTF-8 text", async () => {
    const root = await createTempWorkspace();
    const bytes = Buffer.from("{\"version\":1,\"tasks\":[]}\n", "utf8");
    await writeFile(join(root, "tasks.json"), bytes);

    await expect(readWorkspaceFileRaw(root, "tasks.json")).resolves.toEqual(bytes);
  });

  it("rejects malformed UTF-8 instead of decoding replacement characters", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "tasks.json"), Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));

    await expect(readWorkspaceFileRaw(root, "tasks.json")).rejects.toThrow();
  });

  it("rejects an oversized source instead of truncating it", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "tasks.json"), Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1, 0x61));

    await expect(readWorkspaceFileRaw(root, "tasks.json")).rejects.toThrow(/too large|truncated|exceeds/u);
  });

  it("bounds a file that grows after the initial metadata check", async () => {
    const readLengths: number[] = [];
    const operations: WorkspaceFileRawReadOperations = {
      stat: () => Promise.resolve({ isFile: () => true, size: MAX_WORKSPACE_FILE_BYTES }),
      open: () => Promise.resolve({
        read: (_buffer: Buffer, _offset: number, length: number, position: number | null) => {
          void position;
          readLengths.push(length);
          return Promise.resolve({ bytesRead: length });
        },
        close: () => Promise.resolve(),
      }),
    };

    await expect(readWorkspaceFileBytesFromTarget("tasks.json", operations)).rejects.toThrow(/exceeds/u);
    expect(readLengths).toEqual([MAX_WORKSPACE_FILE_BYTES + 1]);
  });

  it("does not change explorer reader binary and truncation behavior", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "binary.bin"), Buffer.from([0x66, 0x00, 0x6f]));
    await writeFile(join(root, "nested", "large.txt"), "a".repeat(MAX_WORKSPACE_FILE_BYTES + 1));

    await expect(readWorkspaceFileRaw(root, "nested/binary.bin")).rejects.toThrow();
    await expect(readFile(join(root, "nested", "large.txt"))).resolves.toHaveLength(MAX_WORKSPACE_FILE_BYTES + 1);
  });

  it("does not follow a final symlink through the raw browser path", async () => {
    const root = await createTempWorkspace();
    const target = await createTempWorkspace("pi-webui-raw-target-");
    await writeFile(join(target, "tasks.json"), "{}\n");
    await symlink(join(target, "tasks.json"), join(root, "tasks.json"));

    await expect(readWorkspaceFileRaw(root, "tasks.json")).rejects.toThrow();
  });
});
