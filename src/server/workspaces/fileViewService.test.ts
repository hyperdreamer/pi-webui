import { type ReadStream } from "node:fs";
import { appendFile, mkdtemp, mkdir, open, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkspaceFileViewOpener, FileViewError, openWorkspaceFileView } from "./fileViewService.js";
import { PathAccessRootError, resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

let fixture: string;
let root: string;
let allowed: string;
let outside: string;

const supported = [
  ["a.html", "document", "text/html; charset=utf-8", Buffer.from("<p>hello</p>")],
  ["a.htm", "document", "text/html; charset=utf-8", Buffer.from("<p>short</p>")],
  ["a.svg", "document", "image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ["a.pdf", "pdf", "application/pdf", Buffer.from("%PDF-1.7\n")],
  ["a.png", "image", "image/png", Buffer.from([137, 80, 78, 71])],
  ["a.txt", "text", "text/plain; charset=utf-8", Buffer.from("café\n")],
] as const;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "file-view-")));
  root = join(fixture, "root");
  allowed = join(fixture, "allowed");
  outside = join(fixture, "root2");
  await Promise.all([root, allowed, outside].map((path) => mkdir(path)));
  for (const [name, , , bytes] of supported) await writeFile(join(root, name), bytes);
  await writeFile(join(root, "zero.html"), "");
  await writeFile(join(root, "a.exe"), "unknown");
  await mkdir(join(root, "directory.html"));
  await writeFile(join(allowed, "a.html"), "allowed");
  await writeFile(join(outside, "a.html"), "outside");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixture, { recursive: true, force: true });
});

async function bytes(stream: ReadStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected Buffer chunks from a file stream");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function assertClosed(stream: ReadStream): Promise<void> {
  if (!stream.closed) await once(stream, "close");
  expect(stream.closed).toBe(true);
}

const denied = "PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access.";
const unsupported = "This file type cannot be previewed in PI WEBUI.";

for (const [path, kind, mediaType, body] of supported) {
  it(`opens ${path} with exact metadata and bytes`, async () => {
    const expectedStat = await stat(join(root, path));
    const view = await openWorkspaceFileView(root, path);
    expect({ path: view.path, kind: view.kind, mediaType: view.mediaType, size: view.size, modifiedAt: view.modifiedAt }).toEqual({
      path,
      kind,
      mediaType,
      size: body.length,
      modifiedAt: expectedStat.mtime.toISOString(),
    });
    expect(await bytes(view.stream)).toEqual(body);
    await assertClosed(view.stream);
  });
}

it("rejects absent and empty paths before authorization", async () => {
  const authorize = vi.fn<typeof resolveWorkspacePathAccessTarget>();
  const openFile = vi.fn<typeof open>();
  const opener = createWorkspaceFileViewOpener({ authorize, open: openFile });
  for (const path of [undefined, ""]) {
    const error = await opener(root, path).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(FileViewError);
    expect(error).toMatchObject({ status: 400, message: "path query parameter is required" });
  }
  expect(authorize).not.toHaveBeenCalled();
  expect(openFile).not.toHaveBeenCalled();
});

it("rejects NUL paths before authorization", async () => {
  const authorize = vi.fn<typeof resolveWorkspacePathAccessTarget>();
  const error = await createWorkspaceFileViewOpener({ authorize })(root, "a\0.html").catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(FileViewError);
  expect(error).toMatchObject({ status: 400, message: "path query parameter must not contain NUL bytes" });
  expect(authorize).not.toHaveBeenCalled();
});

it("denies traversal, unconfigured absolute paths and symlink escapes", async (context) => {
  for (const path of ["../root2/a.html", join(root, "a.html")]) {
    await expect(openWorkspaceFileView(root, path)).rejects.toMatchObject({ status: 403, message: denied });
  }
  if (process.platform === "win32") {
    context.skip();
    return;
  }
  await symlink(join(outside, "a.html"), join(root, "escape.html"));
  await expect(openWorkspaceFileView(root, "escape.html")).rejects.toMatchObject({ status: 403, message: denied });
  await symlink(join(root, "a.html"), join(root, "inside.html"));
  const inside = await openWorkspaceFileView(root, "inside.html");
  expect(await bytes(inside.stream)).toEqual(Buffer.from("<p>hello</p>"));
  await assertClosed(inside.stream);
});

it("reads an absolute path only through a configured allowed root", async () => {
  const view = await openWorkspaceFileView(root, join(allowed, "a.html"), { allowedPaths: [allowed] });
  expect(view.path).toBe(join(allowed, "a.html"));
  expect(await bytes(view.stream)).toEqual(Buffer.from("allowed"));
  await expect(openWorkspaceFileView(root, join(outside, "a.html"), { allowedPaths: [root] })).rejects.toMatchObject({ status: 403, message: denied });
});

it("maps a missing target to 404 while retaining the request path", async () => {
  await expect(openWorkspaceFileView(root, "missing.html")).rejects.toMatchObject({ status: 404, message: "File not found: missing.html" });
});

it("maps a target below a regular-file ancestor to 404", async () => {
  await expect(openWorkspaceFileView(root, "a.txt/child.html")).rejects.toMatchObject({ status: 404, message: "File not found: a.txt/child.html" });
  const error = await openWorkspaceFileView(join(fixture, "missing-root"), "a.html").catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PathAccessRootError);
});

it("rejects directories and unknown extensions with 415", async () => {
  for (const path of ["directory.html", "a.exe"]) {
    await expect(openWorkspaceFileView(root, path)).rejects.toMatchObject({ status: 415, message: unsupported });
  }
});

it("rejects oversized files after handle measurement and accepts the exact cap", async () => {
  const file = await open(join(root, "huge.html"), "w");
  await file.truncate(67_108_865);
  await file.close();
  await expect(openWorkspaceFileView(root, "huge.html")).rejects.toMatchObject({ status: 413, message: "File is too large to preview (limit 64 MB)." });

  const handle = await open(join(root, "a.html"), "r");
  const measured = await handle.stat();
  // Node's Stats exposes mtime as a prototype getter over mtimeMs, so a spread
  // snapshot would silently lose it; copy the measured fields explicitly.
  const measuredFields = { dev: measured.dev, ino: measured.ino, mtime: measured.mtime, isFile: () => true };
  const streamFactory = vi.fn((options: { start: number; end: number; autoClose: true }) => handle.createReadStream(options));
  const opener = createWorkspaceFileViewOpener({
    open: () => Promise.resolve({
      fd: handle.fd,
      stat: () => Promise.resolve({ ...measuredFields, size: 67_108_864 }),
      createReadStream: streamFactory,
      close: () => handle.close(),
    }),
  });
  const exact = await opener(root, "a.html");
  expect(exact.size).toBe(67_108_864);
  expect(streamFactory).toHaveBeenCalledWith({ start: 0, end: 67_108_863, autoClose: true });
  exact.stream.destroy();
  await assertClosed(exact.stream);
});

it("bounds a file grown after fstat at its measured size", async () => {
  const view = await openWorkspaceFileView(root, "a.txt");
  await appendFile(join(root, "a.txt"), "new tail");
  expect(await bytes(view.stream)).toEqual(Buffer.from("café\n"));
  await assertClosed(view.stream);
});

it("returns a zero-byte stream without reading a file that grows after fstat", async () => {
  const view = await openWorkspaceFileView(root, "zero.html");
  const read = vi.spyOn(view.stream, "_read");
  await appendFile(join(root, "zero.html"), "late bytes");
  expect(await bytes(view.stream)).toEqual(Buffer.alloc(0));
  expect(read).not.toHaveBeenCalled();
  await assertClosed(view.stream);
});
