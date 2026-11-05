import { constants, type ReadStream, type Stats } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { appendFile, chmod, mkdtemp, mkdir, open, realpath, rename, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createWorkspaceFileViewOpener,
  FileViewError,
  openWorkspaceFileView,
  type FileViewDependencies,
  type FileViewHandle,
  type FileViewLstat,
  type FileViewStat,
} from "./fileViewService.js";
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

interface IdentityRow {
  name: string;
  before: { dev: number; ino: number | undefined; symlink?: boolean };
  after: { dev: number; ino: number | undefined };
  opened: boolean;
}

interface ViewHandleOverrides {
  stat?: () => Promise<FileViewStat>;
  createReadStream?: (options: { start: number; end: number; autoClose: true }) => ReadStream;
  close?: () => Promise<void>;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`injected ${code}`);
  error.code = code;
  return error;
}

function fileViewStat(real: Stats, overrides: Partial<FileViewStat> = {}): FileViewStat {
  return { dev: real.dev, ino: real.ino, size: real.size, mtime: real.mtime, isFile: () => true, ...overrides };
}

function fileViewLstat(real: Stats, overrides: Partial<FileViewLstat> = {}): FileViewLstat {
  return { ...fileViewStat(real), isSymbolicLink: () => false, ...overrides };
}

/** Model malformed native metadata (such as a missing inode) at the seam. */
function malformedIdentity<T extends FileViewStat | FileViewLstat>(stat: T, value: { dev: number; ino: number | undefined }): T {
  const next: T = { ...stat, dev: value.dev, ino: value.ino ?? 1 };
  if (value.ino === undefined) Object.defineProperty(next, "ino", { value: undefined, enumerable: true });
  return next;
}

function viewHandle(handle: FileHandle, overrides: ViewHandleOverrides = {}): FileViewHandle {
  return {
    fd: handle.fd,
    stat: overrides.stat ?? (() => handle.stat()),
    createReadStream: overrides.createReadStream ?? ((options) => handle.createReadStream(options)),
    close: overrides.close ?? (() => handle.close()),
  };
}

interface ReportedFifoMessage {
  type: string;
  status?: number | undefined;
  message?: string | undefined;
}

async function stageFailure(filePath: string, build: (real: Stats) => ViewHandleOverrides = () => ({}), dependencies: Partial<FileViewDependencies> = {}) {
  const handle = await open(join(root, filePath), "r");
  const real = await handle.stat();
  const close = vi.spyOn(handle, "close");
  const opener = createWorkspaceFileViewOpener({ ...dependencies, open: () => Promise.resolve(viewHandle(handle, build(real))) });
  const error = await opener(root, filePath).catch((reason: unknown) => reason);
  return { handle, close, error };
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

it.each(["linux", "darwin"] as const)("uses no-follow and nonblocking flags on %s", async (platform) => {
  const openFile = vi.fn<FileViewDependencies["open"]>((path, flags) => {
    expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(flags & (constants.O_WRONLY | constants.O_RDWR)).toBe(0);
    return open(path, flags);
  });
  const view = await createWorkspaceFileViewOpener({ platform, open: openFile })(root, "a.html");
  expect(await bytes(view.stream)).toEqual(Buffer.from("<p>hello</p>"));
  await assertClosed(view.stream);
  expect(openFile).toHaveBeenCalledOnce();
});

it("rejects a final-component symlink swapped after authorization", async (context) => {
  if (process.platform === "win32") {
    context.skip();
    return;
  }
  const authorize: FileViewDependencies["authorize"] = async (...args) => {
    const target = await resolveWorkspacePathAccessTarget(...args);
    await rename(target.target, join(root, "original.html"));
    await symlink(join(root, "a.htm"), target.target);
    return target;
  };
  const error = await createWorkspaceFileViewOpener({ authorize })(root, "a.html").catch((reason: unknown) => reason);
  expect(error).toMatchObject({ status: 403, message: denied });
});

it("rejects an opened Linux handle outside its granting root", async () => {
  const handle = await open(join(outside, "a.html"), "r");
  const close = vi.spyOn(handle, "close");
  const error = await createWorkspaceFileViewOpener({ platform: "linux", open: () => Promise.resolve(handle) })(root, "a.html").catch((reason: unknown) => reason);
  expect(error).toMatchObject({ status: 403, message: denied });
  expect(close).toHaveBeenCalledOnce();
});

it("rejects a Linux opened-handle near-prefix sibling", async () => {
  const handle = await open(join(outside, "a.html"), "r");
  const close = vi.spyOn(handle, "close");
  const view = createWorkspaceFileViewOpener({ platform: "linux", open: () => Promise.resolve(handle), realpath: () => Promise.resolve(join(outside, "a.html")) });
  const error = await view(root, "a.html").catch((reason: unknown) => reason);
  expect(error).toMatchObject({ status: 403 });
  expect(close).toHaveBeenCalledOnce();
});

it("fails closed when Linux fd containment lookup fails", async () => {
  const handle = await open(join(root, "a.html"), "r");
  const close = vi.spyOn(handle, "close");
  const view = createWorkspaceFileViewOpener({ platform: "linux", open: () => Promise.resolve(handle), realpath: () => Promise.reject(new Error("proc unavailable")) });
  const error = await view(root, "a.html").catch((reason: unknown) => reason);
  expect(error).toMatchObject({ status: 403 });
  expect(close).toHaveBeenCalledOnce();
});

it("does not perform Linux fd lookup on another POSIX host", async () => {
  const lookup = vi.fn(() => Promise.reject(new Error("Linux-only lookup")));
  const view = await createWorkspaceFileViewOpener({ platform: "darwin", realpath: lookup })(root, "a.html");
  expect(await bytes(view.stream)).toEqual(Buffer.from("<p>hello</p>"));
  expect(lookup).not.toHaveBeenCalled();
});

it("streams the pinned handle when the pathname is replaced after open", async () => {
  const handle = await open(join(root, "a.html"), "r");
  let created: ReadStream | undefined;
  const opener = createWorkspaceFileViewOpener({
    open: () => Promise.resolve({
      fd: handle.fd,
      stat: () => handle.stat(),
      close: () => handle.close(),
      createReadStream: (options) => {
        created = handle.createReadStream(options);
        return created;
      },
    }),
  });
  const view = await opener(root, "a.html");
  expect(view.stream).toBe(created);
  await rename(join(root, "a.html"), join(root, "old.html"));
  await writeFile(join(root, "a.html"), "replacement");
  expect(await bytes(view.stream)).toEqual(Buffer.from("<p>hello</p>"));
  await assertClosed(view.stream);
});

it("uses conclusive Windows identity and fstat size", async () => {
  const handle = await open(join(root, "a.html"), "r");
  const real = await handle.stat();
  const lookup = vi.fn(() => Promise.reject(new Error("proc on Windows")));
  const openFile = vi.fn<FileViewDependencies["open"]>((_path, flags) => {
    expect(flags).toBe(constants.O_RDONLY);
    return Promise.resolve({
      fd: handle.fd,
      stat: () => Promise.resolve(fileViewStat(real, { dev: 1, ino: 7 })),
      createReadStream: (options) => handle.createReadStream(options),
      close: () => handle.close(),
    });
  });
  const view = await createWorkspaceFileViewOpener({
    platform: "win32",
    open: openFile,
    realpath: lookup,
    lstat: () => Promise.resolve(fileViewLstat(real, { dev: 1, ino: 7, size: 999_999_999 })),
  })(root, "a.html");
  expect(view.size).toBe(12);
  expect(await bytes(view.stream)).toEqual(Buffer.from("<p>hello</p>"));
  expect(lookup).not.toHaveBeenCalled();
});

const identityFailures: IdentityRow[] = [
  { name: "lstat symlink", before: { dev: 1, ino: 7, symlink: true }, after: { dev: 1, ino: 7 }, opened: false },
  { name: "dev mismatch", before: { dev: 1, ino: 7 }, after: { dev: 2, ino: 7 }, opened: true },
  { name: "ino mismatch", before: { dev: 1, ino: 7 }, after: { dev: 1, ino: 8 }, opened: true },
  { name: "zero inode", before: { dev: 1, ino: 0 }, after: { dev: 1, ino: 0 }, opened: true },
  { name: "NaN dev", before: { dev: Number.NaN, ino: 7 }, after: { dev: Number.NaN, ino: 7 }, opened: true },
  // `missing inode` deliberately models malformed native metadata at the seam.
  { name: "missing inode", before: { dev: 1, ino: undefined }, after: { dev: 1, ino: undefined }, opened: true },
  { name: "unsafe integer identity", before: { dev: 1, ino: 2 ** 53 }, after: { dev: 1, ino: 2 ** 53 }, opened: true },
];

for (const row of identityFailures) {
  it(`denies ${row.name}`, async () => {
    const handle = await open(join(root, "a.html"), "r");
    const real = await handle.stat();
    const close = vi.spyOn(handle, "close");
    const openFile = vi.fn<FileViewDependencies["open"]>(() => Promise.resolve(viewHandle(handle, { stat: () => Promise.resolve(malformedIdentity(fileViewStat(real), row.after)) })));
    try {
      const error = await createWorkspaceFileViewOpener({
        platform: "win32",
        open: openFile,
        lstat: () => Promise.resolve(malformedIdentity(fileViewLstat(real, { isSymbolicLink: () => row.before.symlink === true }), row.before)),
      })(root, "a.html").catch((reason: unknown) => reason);
      expect(error).toMatchObject({ status: 403, message: denied });
      expect(openFile.mock.calls.length).toBe(row.opened ? 1 : 0);
      expect(close.mock.calls.length).toBe(row.opened ? 1 : 0);
    } finally {
      if (!row.opened) await handle.close();
    }
  });
}

it("rejects a real Unix-domain socket target with 415", async (context) => {
  if (process.platform === "win32") {
    context.skip();
    return;
  }
  const socketPath = join(root, "socket.html");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { resolve(); });
  });
  try {
    const expected = process.platform === "linux" ? "ENXIO" : "EOPNOTSUPP";
    let nativeCode: string | undefined;
    try {
      const handle = await open(socketPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      await handle.close();
    } catch (error) {
      nativeCode = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
    }
    expect(nativeCode).toBe(expected);
    const error = await openWorkspaceFileView(root, "socket.html").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 415, message: unsupported });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
  for (const code of ["ENXIO", "EOPNOTSUPP"]) {
    const error = await createWorkspaceFileViewOpener({ open: () => Promise.reject(errnoError(code)) })(root, "a.html").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 415, message: unsupported });
  }
});

it("rejects a FIFO without a writer within the parent-owned deadline", async (context) => {
  if (process.platform === "win32") {
    context.skip();
    return;
  }
  const fifoPath = join(root, "fifo.html");
  const created = spawnSync("mkfifo", [fifoPath]);
  if (created.status !== 0) {
    context.skip();
    return;
  }
  const moduleUrl = new URL("./fileViewService.ts", import.meta.url).href;
  const source = `
    import { open } from "node:fs/promises";
    import { createWorkspaceFileViewOpener } from ${JSON.stringify(moduleUrl)};
    const opener = createWorkspaceFileViewOpener({
      open: async (path, flags) => {
        process.send({ type: "ready" });
        await new Promise((resolve) => process.once("message", (message) => { if (message === "go") resolve(); }));
        return await open(path, flags);
      },
    });
    try {
      await opener(${JSON.stringify(root)}, "fifo.html");
      process.send({ type: "success" });
    } catch (error) {
      process.send({ type: "error", status: error?.status, message: error?.message });
    }
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => { stderr.push(chunk); });
  const ready = deferred<undefined>();
  const reported = deferred<ReportedFifoMessage>();
  const exited = deferred<undefined>();
  child.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    const type = message.type;
    if (type === "ready") {
      ready.resolve(undefined);
    } else if (type === "error" || type === "success") {
      reported.resolve({
        type,
        status: "status" in message && typeof message.status === "number" ? message.status : undefined,
        message: "message" in message && typeof message.message === "string" ? message.message : undefined,
      });
    }
  });
  child.once("exit", () => { exited.resolve(undefined); });
  const startupFailure = new Error("FIFO child failed to start");
  const startup = setTimeout(() => { ready.reject(startupFailure); }, 20_000);
  let failure: unknown;
  try {
    await ready.promise.finally(() => { clearTimeout(startup); });
    const started = performance.now();
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => { reject(new Error("FIFO open exceeded 1000 ms")); }, 1000);
    });
    child.send("go");
    const message = await Promise.race([reported.promise, deadline]);
    expect(performance.now() - started).toBeLessThanOrEqual(1000);
    expect(message).toMatchObject({ type: "error", status: 415, message: unsupported });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(startup);
    if (!child.killed) child.kill("SIGKILL");
    await exited.promise;
  }
  if (failure !== undefined) {
    const diagnostics = stderr.length === 0 ? "" : ` stderr: ${Buffer.concat(stderr).toString()}`;
    throw new Error(`${failure instanceof Error ? failure.message : "FIFO probe failed"}${diagnostics}`);
  }
});

it("closes every handle on fstat rejection", async () => {
  const failure = new Error("fstat failed");
  const { close, error } = await stageFailure("a.html", () => ({ stat: () => Promise.reject(failure) }));
  expect(error).toBe(failure);
  expect(close).toHaveBeenCalledOnce();
});

it("closes every handle on nonregular metadata", async () => {
  const { close, error } = await stageFailure("a.html", (real) => ({ stat: () => Promise.resolve(fileViewStat(real, { isFile: () => false })) }));
  expect(error).toMatchObject({ status: 415, message: unsupported });
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  ["negative", -1],
  ["NaN", Number.NaN],
  ["unsafe", 2 ** 53],
  ["fractional", 1.5],
] as const)("closes every handle on invalid size (%s)", async (_label, size) => {
  const { close, error } = await stageFailure("a.html", (real) => ({ stat: () => Promise.resolve(fileViewStat(real, { size })) }));
  expect(error).toMatchObject({ status: 403, message: denied });
  expect(close).toHaveBeenCalledOnce();
});

it("closes every handle on oversized measurement", async () => {
  const { close, error } = await stageFailure("a.html", (real) => ({ stat: () => Promise.resolve(fileViewStat(real, { size: 67_108_865 })) }));
  expect(error).toMatchObject({ status: 413, message: "File is too large to preview (limit 64 MB)." });
  expect(close).toHaveBeenCalledOnce();
});

it("closes every handle on Windows identity mismatch", async () => {
  const { close, error } = await stageFailure("a.html", (real) => ({ stat: () => Promise.resolve(fileViewStat(real, { dev: real.dev + 1 })) }), { platform: "win32" });
  expect(error).toMatchObject({ status: 403, message: denied });
  expect(close).toHaveBeenCalledOnce();
});

it("closes every handle on Linux lookup failure", async () => {
  const { close, error } = await stageFailure("a.html", () => ({}), { platform: "linux", realpath: () => Promise.reject(new Error("proc unavailable")) });
  expect(error).toMatchObject({ status: 403, message: denied });
  expect(close).toHaveBeenCalledOnce();
});

it("closes every handle on unknown kind", async () => {
  const { close, error } = await stageFailure("a.exe");
  expect(error).toMatchObject({ status: 415, message: unsupported });
  expect(close).toHaveBeenCalledOnce();
});

it("closes every handle on createReadStream throw", async () => {
  const failure = new Error("stream setup failed");
  const { close, error } = await stageFailure("a.html", () => ({ createReadStream: () => { throw failure; } }));
  expect(error).toBe(failure);
  expect(close).toHaveBeenCalledOnce();
});

it("closes every handle on zero-size push failure", async () => {
  const handle = await open(join(root, "zero.html"), "r");
  const real = await handle.stat();
  const stream = handle.createReadStream({ start: 0, end: 0, autoClose: true });
  const originalPush = stream.push.bind(stream);
  let thrown = false;
  const push = vi.spyOn(stream, "push").mockImplementation((chunk: unknown, encoding?: BufferEncoding) => {
    if (!thrown && chunk === null) {
      thrown = true;
      throw new Error("EOF setup failed");
    }
    return originalPush(chunk, encoding);
  });
  const closed = once(stream, "close");
  const opener = createWorkspaceFileViewOpener({
    open: () => Promise.resolve(viewHandle(handle, {
      stat: () => Promise.resolve(fileViewStat(real, { size: 0 })),
      createReadStream: () => stream,
    })),
  });
  const error = await opener(root, "zero.html").catch((reason: unknown) => reason);
  expect(error).toMatchObject({ message: "EOF setup failed" });
  await closed;
  expect(stream.closed).toBe(true);
  expect(push).toHaveBeenCalled();
});

it("preserves the primary failure when cleanup close rejects", async () => {
  const handle = await open(join(root, "a.exe"), "r");
  const close = vi.fn(() => handle.close().then(() => { throw new Error("close failed"); }));
  const opener = createWorkspaceFileViewOpener({ open: () => Promise.resolve(viewHandle(handle, { close })) });
  const error = await opener(root, "a.exe").catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(FileViewError);
  expect(error).toMatchObject({ status: 415, message: unsupported });
  expect(close).toHaveBeenCalledOnce();
  const cause = error instanceof Error ? error.cause : undefined;
  expect(cause).toBeInstanceOf(AggregateError);
  if (cause instanceof AggregateError) {
    expect(cause.message).toBe("File-view cleanup failed");
    expect(cause.errors.map((entry: unknown) => entry instanceof Error ? entry.message : String(entry))).toEqual(["close failed"]);
  }
});

it("maps authorization-stage target permission and loop errors to 403", async (context) => {
  if (process.platform === "win32") {
    context.skip();
    return;
  }
  const blocked = join(root, "blocked");
  await mkdir(blocked);
  await writeFile(join(blocked, "child.html"), "<p>blocked</p>");
  const loop = join(root, "loop.html");
  await symlink("loop.html", loop);
  const openFile = vi.fn<FileViewDependencies["open"]>();
  try {
    if (process.getuid?.() !== 0) {
      await chmod(blocked, 0);
      const permission = await createWorkspaceFileViewOpener({ open: openFile })(root, "blocked/child.html").catch((reason: unknown) => reason);
      expect(permission).toMatchObject({ status: 403, message: denied });
    }
    const cycle = await createWorkspaceFileViewOpener({ open: openFile })(root, "loop.html").catch((reason: unknown) => reason);
    expect(cycle).toMatchObject({ status: 403, message: denied });
  } finally {
    await chmod(blocked, 0o700);
  }
  for (const code of ["EACCES", "EPERM", "ELOOP"]) {
    const authorize: FileViewDependencies["authorize"] = () => Promise.reject(errnoError(code));
    const error = await createWorkspaceFileViewOpener({ authorize, open: openFile })(root, "a.html").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 403, message: denied });
  }
  expect(openFile).not.toHaveBeenCalled();
});

it("maps root-stage canonicalization failures to 500", async (context) => {
  if (process.platform === "win32") {
    context.skip();
    return;
  }
  const cycle = join(root, "cycle");
  await symlink(cycle, cycle);
  const blocked = join(root, "blocked-root");
  await mkdir(blocked);
  await mkdir(join(blocked, "child"));
  const openFile = vi.fn<FileViewDependencies["open"]>();
  const opener = createWorkspaceFileViewOpener({ open: openFile });
  const badRoots = [join(fixture, "missing-root"), join(root, "a.txt"), cycle];
  try {
    if (process.getuid?.() !== 0) {
      await chmod(blocked, 0);
      badRoots.push(join(blocked, "child"));
    }
    for (const bad of badRoots) {
      const workspaceError = await opener(bad, "a.html").catch((reason: unknown) => reason);
      expect(workspaceError).toBeInstanceOf(PathAccessRootError);
      const allowedError = await opener(root, join(bad, "a.html"), { allowedPaths: [bad] }).catch((reason: unknown) => reason);
      expect(allowedError).toBeInstanceOf(PathAccessRootError);
    }
    if (process.getuid?.() !== 0) {
      const targetError = await opener(blocked, "child/a.html").catch((reason: unknown) => reason);
      expect(targetError).toMatchObject({ status: 403, message: denied });
    }
  } finally {
    await chmod(blocked, 0o700);
  }
  expect(openFile).not.toHaveBeenCalled();
});

it("maps open-stage permission errors to 403 and unexpected filesystem errors to rejection", async () => {
  for (const code of ["EACCES", "EPERM", "ELOOP"]) {
    const error = await createWorkspaceFileViewOpener({ open: () => Promise.reject(errnoError(code)) })(root, "a.html").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 403, message: denied });
  }
  for (const code of ["ENOENT", "ENOTDIR"]) {
    const error = await createWorkspaceFileViewOpener({ open: () => Promise.reject(errnoError(code)) })(root, "a.html").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 404, message: "File not found: a.html" });
  }
  const failure = errnoError("EIO");
  const error = await createWorkspaceFileViewOpener({ open: () => Promise.reject(failure) })(root, "a.html").catch((reason: unknown) => reason);
  expect(error).toBe(failure);
});

it("treats whitespace-only and space-prefixed names as literal paths", async () => {
  await writeFile(join(root, " "), "space");
  await writeFile(join(root, " a.txt"), "spaced");
  await expect(openWorkspaceFileView(root, " ")).rejects.toMatchObject({ status: 415, message: unsupported });
  const view = await openWorkspaceFileView(root, " a.txt");
  expect(view.path).toBe(" a.txt");
  expect(await bytes(view.stream)).toEqual(Buffer.from("spaced"));
  await assertClosed(view.stream);
});
