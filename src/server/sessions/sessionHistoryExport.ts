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
    return patchSessionHistoryExportHtml(await readFile(outputPath, "utf8"));
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

/**
 * Pi 0.80's generated viewer uses recursion for tree preparation. Replace
 * those helpers in the generated document so a long linear session remains
 * viewable instead of exhausting the browser call stack.
 */
export function patchSessionHistoryExportHtml(html: string): string {
  const normalizeLineEndings = (value: string): string => value.replace(/\r\n/g, "\n");
  const replaceRequired = (source: string, name: string, search: string, replacement: string): string => {
    const normalizedSearch = normalizeLineEndings(search);
    const normalizedReplacement = normalizeLineEndings(replacement);
    const matches = source.split(normalizedSearch).length - 1;
    if (matches !== 1) throw new Error(`Failed to patch exported HTML: ${name} expected 1 match, found ${String(matches)}`);
    return source.replace(normalizedSearch, normalizedReplacement);
  };

  let patched = normalizeLineEndings(html);
  patched = replaceRequired(
    patched,
    "sortChildren",
    `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
    `        function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }
        }`,
  );
  patched = replaceRequired(
    patched,
    "mapNodes",
    `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
    `          const stack = [...tree].reverse();
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }`,
  );
  return replaceRequired(
    patched,
    "markActive",
    `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`,
    `        function markActive(root) {
          const stack1 = [root];
          const stack2 = [];
          while (stack1.length) {
            const node = stack1.pop();
            stack2.push(node);
            for (const child of node.children) {
              stack1.push(child);
            }
          }
          while (stack2.length) {
            const node = stack2.pop();
            let has = activePathIds.has(node.entry.id);
            for (const child of node.children) {
              if (containsActive.get(child)) has = true;
            }
            containsActive.set(node, has);
          }
        }`,
  );
}

function piCliPath(): string {
  const path = join(getPackageDir(), "dist", "cli.js");
  if (!existsSync(path)) throw new Error("Pi HTML exporter is unavailable");
  return path;
}
