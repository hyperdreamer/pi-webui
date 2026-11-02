import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCallback);
const EXPORT_TIMEOUT_MS = 30_000;
const EXPORT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Generate Pi's self-contained history viewer for a persisted session file.
 *
 * Pi's public package entry point exposes its package directory, while the
 * export CLI is the version-stable interface for rendering a session file.
 * Pi prepares the viewer's tree iteratively, so long linear sessions render
 * without the document needing post-processing here.
 */
export async function exportSessionHistoryHtml(sessionFile: string): Promise<string> {
  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-webui-history-"));
  const outputPath = join(outputDirectory, "history.html");
  try {
    await execFile(process.execPath, [piCliPath(), "--export", sessionFile, outputPath], {
      cwd: process.cwd(),
      timeout: EXPORT_TIMEOUT_MS,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      maxBuffer: EXPORT_MAX_BUFFER_BYTES,
    });
    return await readFile(outputPath, "utf8");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

function piCliPath(): string {
  const path = join(getPackageDir(), "dist", "cli.js");
  if (!existsSync(path)) throw new Error("Pi HTML exporter is unavailable");
  return path;
}
