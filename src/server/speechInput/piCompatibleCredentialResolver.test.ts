import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCredentialCommandRunner,
  inspectPiCompatibleCredentialSource,
  resolvePiCompatibleCredentialSource,
  SPEECH_INPUT_CREDENTIAL_COMMAND_TIMEOUT_MS,
  SPEECH_INPUT_CREDENTIAL_MAX_STDOUT_BYTES,
  type CredentialCommandRequest,
  type CredentialCommandRunner,
  type CredentialProcessHost,
  type CredentialSpawnedProcess,
  type ResolveCredentialOptions,
} from "./piCompatibleCredentialResolver.js";

interface CredentialCloseResult {
  code: number | null;
  error?: Error;
}

class ControlledCredentialProcess implements CredentialSpawnedProcess {
  readonly pid: number | undefined;
  private readonly stdoutListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly stderrListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<(result: CredentialCloseResult) => void>();
  stdoutUnsubscribeCalls = 0;
  stderrUnsubscribeCalls = 0;
  closeUnsubscribeCalls = 0;
  stderrDeliveryCount = 0;
  processExitEmitted = false;

  constructor(options: { pid: number | undefined } = { pid: 4321 }) {
    this.pid = options.pid;
  }

  onStdout(listener: (chunk: Uint8Array) => void): () => void {
    this.stdoutListeners.add(listener);
    return () => {
      this.stdoutUnsubscribeCalls += 1;
      this.stdoutListeners.delete(listener);
    };
  }

  onStderr(listener: (chunk: Uint8Array) => void): () => void {
    this.stderrListeners.add(listener);
    return () => {
      this.stderrUnsubscribeCalls += 1;
      this.stderrListeners.delete(listener);
    };
  }

  onClose(listener: (result: CredentialCloseResult) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeUnsubscribeCalls += 1;
      this.closeListeners.delete(listener);
    };
  }

  emitStdout(chunk: Uint8Array): void {
    for (const listener of this.stdoutListeners) listener(chunk);
  }

  emitStderr(chunk: Uint8Array): void {
    for (const listener of this.stderrListeners) {
      this.stderrDeliveryCount += 1;
      listener(chunk);
    }
  }

  emitProcessExit(): void {
    this.processExitEmitted = true;
  }

  emitStreamClose(result: CredentialCloseResult): void {
    for (const listener of this.closeListeners) listener(result);
  }

  listenerCounts(): { stdout: number; stderr: number; close: number } {
    return {
      stdout: this.stdoutListeners.size,
      stderr: this.stderrListeners.size,
      close: this.closeListeners.size,
    };
  }
}

class ImmediatelyClosingCredentialProcess extends ControlledCredentialProcess {
  override onClose(listener: (result: CredentialCloseResult) => void): () => void {
    const unsubscribe = super.onClose(listener);
    listener({ code: 0 });
    return unsubscribe;
  }
}

interface ControlledDeadline {
  callback: () => void;
  delayMs: number;
  cancelCalls: number;
}

class ControlledCredentialProcessHost implements CredentialProcessHost {
  readonly process: ControlledCredentialProcess;
  readonly spawnedCommands: string[] = [];
  readonly terminatedProcesses: CredentialSpawnedProcess[] = [];
  readonly deadlines: ControlledDeadline[] = [];

  constructor(process = new ControlledCredentialProcess()) {
    this.process = process;
  }

  spawn(command: string): CredentialSpawnedProcess {
    this.spawnedCommands.push(command);
    return this.process;
  }

  terminateTrackedProcesses(process: CredentialSpawnedProcess): void {
    this.terminatedProcesses.push(process);
  }

  scheduleDeadline(callback: () => void, delayMs: number): () => void {
    const deadline: ControlledDeadline = { callback, delayMs, cancelCalls: 0 };
    this.deadlines.push(deadline);
    return () => { deadline.cancelCalls += 1; };
  }

  firstDeadline(): ControlledDeadline {
    const deadline = this.deadlines[0];
    if (deadline === undefined) throw new Error("Expected a credential deadline");
    return deadline;
  }
}

function resolutionOptions(env?: NodeJS.ProcessEnv): ResolveCredentialOptions {
  return {
    signal: new AbortController().signal,
    ...(env === undefined ? {} : { env }),
  };
}

function commandRequest(signal: AbortSignal, command = "secret-command"): CredentialCommandRequest {
  return {
    command,
    signal,
    timeoutMs: SPEECH_INPUT_CREDENTIAL_COMMAND_TIMEOUT_MS,
    maxStdoutBytes: SPEECH_INPUT_CREDENTIAL_MAX_STDOUT_BYTES,
  };
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  let rejected = false;
  let reason: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    rejected = true;
    reason = error;
  }
  if (!rejected) throw new Error("Expected credential resolution to reject");
  if (!(reason instanceof Error)) throw new Error("Credential resolution rejected with a non-Error value");
  return reason.message;
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = previous;
}

function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function waitForFileEvent(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const targetName = basename(path);
    const watcher = watch(dirname(path), (_eventType, filename) => {
      if (filename?.toString() !== targetName) return;
      watcher.close();
      resolve();
    });
    watcher.on("error", (error: Error) => {
      watcher.close();
      reject(error);
    });
  });
}

async function stopDetachedChild(pid: number, stoppedPath: string): Promise<void> {
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    const stopped = new Promise<void>((resolve, reject) => {
      watcher = watch(dirname(stoppedPath), (_eventType, filename) => {
        if (filename?.toString() !== basename(stoppedPath)) return;
        watcher?.close();
        resolve();
      });
      watcher.on("error", (error: Error) => {
        watcher?.close();
        reject(error);
      });
    });
    process.kill(pid, "SIGTERM");
    await stopped;
  } catch {
    watcher?.close();
    try { process.kill(pid, "SIGKILL"); } catch { /* The detached process already exited. */ }
  }
}

describe("Pi-compatible speech-input credential sources", () => {
  it("resolves literal values, environment templates, and escaped dollar sequences", async () => {
    expect(await resolvePiCompatibleCredentialSource("literal-key", resolutionOptions())).toBe("literal-key");
    expect(await resolvePiCompatibleCredentialSource("$TOKEN", resolutionOptions({ TOKEN: "env-key" }))).toBe("env-key");
    expect(await resolvePiCompatibleCredentialSource("${PREFIX}_${SUFFIX}", resolutionOptions({ PREFIX: "a", SUFFIX: "b" }))).toBe("a_b");
    expect(await resolvePiCompatibleCredentialSource("$$cash-$!bang", resolutionOptions())).toBe("$cash-!bang");
  });

  it("resolves unbraced environment names containing digits after the first character", async () => {
    expect(await resolvePiCompatibleCredentialSource("$FOO1", resolutionOptions({ FOO: "wrong", FOO1: "right" }))).toBe("right");
  });

  it("preserves malformed braced references as literals", async () => {
    expect(await resolvePiCompatibleCredentialSource("${NOT-AN_ENV}", resolutionOptions())).toBe("${NOT-AN_ENV}");
    expect(await resolvePiCompatibleCredentialSource("${UNTERMINATED", resolutionOptions())).toBe("${UNTERMINATED");
  });

  it("reports missing, literal, environment, and command source status without running commands", () => {
    const absentName = "PI_WEBUI_SPEECH_INPUT_ABSENT_TEST_VALUE";
    const previous = process.env[absentName];
    try {
      Reflect.deleteProperty(process.env, absentName);
      expect(inspectPiCompatibleCredentialSource(undefined)).toEqual({ configured: false, resolution: "missing" });
      expect(inspectPiCompatibleCredentialSource("literal-key")).toEqual({ configured: true, source: "literal", resolution: "resolved" });
      expect(inspectPiCompatibleCredentialSource(`$${absentName}`, { [absentName]: "env-key" })).toEqual({ configured: true, source: "environment", resolution: "resolved" });
      expect(inspectPiCompatibleCredentialSource(`$${absentName}`, {})).toEqual({ configured: true, source: "environment", resolution: "unresolved" });
      expect(inspectPiCompatibleCredentialSource("!echo should-not-run")).toEqual({ configured: true, source: "command", resolution: "unchecked" });
    } finally {
      restoreEnvironment(absentName, previous);
    }
  });

  it("uses Pi's supplied-environment then process-environment precedence", async () => {
    const name = "PI_WEBUI_SPEECH_INPUT_ENV_PRECEDENCE_TEST";
    const previous = process.env[name];
    try {
      process.env[name] = "process-key";
      expect(await resolvePiCompatibleCredentialSource(`$${name}`, resolutionOptions({ [name]: "supplied-key" }))).toBe("supplied-key");
      expect(await resolvePiCompatibleCredentialSource(`$${name}`, resolutionOptions({ [name]: "" }))).toBe("process-key");
      Reflect.deleteProperty(process.env, name);
      await expect(resolvePiCompatibleCredentialSource(`$${name}`, resolutionOptions({ [name]: "" }))).rejects.toThrow("Credential source could not be resolved");
    } finally {
      restoreEnvironment(name, previous);
    }
  });

  it("strips a leading command marker and passes the shared bounds and caller signal to its runner", async () => {
    const controller = new AbortController();
    const requests: CredentialCommandRequest[] = [];
    const runCommand: CredentialCommandRunner = (request) => {
      requests.push(request);
      return Promise.resolve("command-key");
    };

    await expect(resolvePiCompatibleCredentialSource("!echo secret-command", { signal: controller.signal, runCommand })).resolves.toBe("command-key");
    expect(requests).toEqual([{
      command: "echo secret-command",
      signal: controller.signal,
      timeoutMs: SPEECH_INPUT_CREDENTIAL_COMMAND_TIMEOUT_MS,
      maxStdoutBytes: SPEECH_INPUT_CREDENTIAL_MAX_STDOUT_BYTES,
    }]);
  });

  it("normalizes command-runner failures without exposing command text or resolved values", async () => {
    const runCommand: CredentialCommandRunner = () => Promise.reject(new Error("secret-command resolved-value"));

    const message = await rejectionMessage(resolvePiCompatibleCredentialSource("!secret-command", {
      signal: new AbortController().signal,
      runCommand,
    }));

    expect(message).toBe("Credential command failed");
    expect(message).not.toContain("secret-command");
    expect(message).not.toContain("resolved-value");
  });
});

describe("createCredentialCommandRunner", () => {
  it("waits for stream close, includes stdout after process exit, trims once, drains stderr, and cleans listeners", async () => {
    const host = new ControlledCredentialProcessHost();
    const runner = createCredentialCommandRunner(host);
    const completion = runner(commandRequest(new AbortController().signal));
    let settled = false;
    void completion.then(() => { settled = true; }, () => { settled = true; });

    host.process.emitStdout(encode(" credential"));
    host.process.emitStderr(encode("ignored stderr"));
    host.process.emitProcessExit();
    await Promise.resolve();

    expect(host.process.processExitEmitted).toBe(true);
    expect(settled).toBe(false);
    expect(host.process.stderrDeliveryCount).toBe(1);
    expect(host.deadlines).toHaveLength(1);
    expect(host.firstDeadline().delayMs).toBe(SPEECH_INPUT_CREDENTIAL_COMMAND_TIMEOUT_MS);

    host.process.emitStdout(encode("\n"));
    host.process.emitStreamClose({ code: 0 });

    await expect(completion).resolves.toBe("credential");
    expect(host.process.listenerCounts()).toEqual({ stdout: 0, stderr: 0, close: 0 });
    expect(host.process.stdoutUnsubscribeCalls).toBe(1);
    expect(host.process.stderrUnsubscribeCalls).toBe(1);
    expect(host.process.closeUnsubscribeCalls).toBe(1);
    expect(host.firstDeadline().cancelCalls).toBe(1);
  });

  it("arms its one deadline immediately after accepting a spawned process", async () => {
    const calls: string[] = [];
    let close: ((result: CredentialCloseResult) => void) | undefined;
    const process: CredentialSpawnedProcess = {
      pid: 4321,
      onStdout: () => {
        calls.push("stdout");
        return () => undefined;
      },
      onStderr: () => {
        calls.push("stderr");
        return () => undefined;
      },
      onClose: (listener) => {
        calls.push("close");
        close = listener;
        return () => undefined;
      },
    };
    const host: CredentialProcessHost = {
      spawn: () => {
        calls.push("spawn");
        return process;
      },
      terminateTrackedProcesses: () => undefined,
      scheduleDeadline: () => {
        calls.push("deadline");
        return () => undefined;
      },
    };

    const completion = createCredentialCommandRunner(host)(commandRequest(new AbortController().signal));

    expect(calls).toEqual(["spawn", "deadline", "stdout", "stderr", "close"]);
    if (close === undefined) throw new Error("Expected credential close listener");
    close({ code: 0 });
    await expect(completion).rejects.toThrow("Credential command produced no credential");
  });

  it("rejects an empty command output", async () => {
    const host = new ControlledCredentialProcessHost();
    const completion = createCredentialCommandRunner(host)(commandRequest(new AbortController().signal));

    host.process.emitStreamClose({ code: 0 });

    await expect(completion).rejects.toThrow("Credential command produced no credential");
  });

  it("cancels its deadline when close arrives while listeners are attached", async () => {
    const host = new ControlledCredentialProcessHost(new ImmediatelyClosingCredentialProcess());

    const completion = createCredentialCommandRunner(host)(commandRequest(new AbortController().signal));

    await expect(completion).rejects.toThrow("Credential command produced no credential");
    expect(host.deadlines).toHaveLength(1);
    expect(host.firstDeadline().cancelCalls).toBe(1);
    expect(host.process.listenerCounts()).toEqual({ stdout: 0, stderr: 0, close: 0 });
  });

  it("rejects a nonzero close without exposing the command", async () => {
    const host = new ControlledCredentialProcessHost();
    const completion = createCredentialCommandRunner(host)(commandRequest(new AbortController().signal, "secret-command"));

    host.process.emitStreamClose({ code: 1, error: new Error("secret-command stderr") });

    const message = await rejectionMessage(completion);
    expect(message).toBe("Credential command failed");
    expect(message).not.toContain("secret-command");
  });

  it("keeps the resolution error stable when listener or timer cleanup fails", async () => {
    let close: ((result: CredentialCloseResult) => void) | undefined;
    const host: CredentialProcessHost = {
      spawn: () => ({
        pid: 4321,
        onStdout: () => () => { throw new Error("secret-command resolved-value"); },
        onStderr: () => () => { throw new Error("secret-command resolved-value"); },
        onClose: (listener) => {
          close = listener;
          return () => { throw new Error("secret-command resolved-value"); };
        },
      }),
      terminateTrackedProcesses: () => undefined,
      scheduleDeadline: () => () => { throw new Error("secret-command resolved-value"); },
    };
    const completion = createCredentialCommandRunner(host)(commandRequest(new AbortController().signal, "secret-command"));

    if (close === undefined) throw new Error("Expected credential close listener");
    close({ code: 1 });

    const message = await rejectionMessage(completion);
    expect(message).toBe("Credential command failed");
    expect(message).not.toContain("secret-command");
    expect(message).not.toContain("resolved-value");
  });

  it("normalizes listener-registration failures and terminates the accepted process", async () => {
    const process = new ControlledCredentialProcess();
    const terminated: CredentialSpawnedProcess[] = [];
    const host: CredentialProcessHost = {
      spawn: () => process,
      terminateTrackedProcesses: (accepted) => { terminated.push(accepted); },
      scheduleDeadline: () => () => undefined,
    };
    process.onStdout = () => { throw new Error("secret-command resolved-value"); };

    const message = await rejectionMessage(createCredentialCommandRunner(host)(commandRequest(new AbortController().signal, "secret-command")));

    expect(message).toBe("Credential command failed");
    expect(message).not.toContain("secret-command");
    expect(message).not.toContain("resolved-value");
    expect(terminated).toEqual([process]);
  });

  it("normalizes a synchronous spawn failure", async () => {
    const host: CredentialProcessHost = {
      spawn: () => { throw new Error("secret-command spawn failure"); },
      terminateTrackedProcesses: () => undefined,
      scheduleDeadline: () => () => undefined,
    };

    const message = await rejectionMessage(createCredentialCommandRunner(host)(commandRequest(new AbortController().signal)));
    expect(message).toBe("Credential command failed");
    expect(message).not.toContain("secret-command");
  });

  it("normalizes an asynchronous spawn error without attempting cleanup for an undefined PID", async () => {
    const host = new ControlledCredentialProcessHost(new ControlledCredentialProcess({ pid: undefined }));
    const completion = createCredentialCommandRunner(host)(commandRequest(new AbortController().signal));

    host.process.emitStreamClose({ code: null, error: new Error("secret-command spawn error") });

    const message = await rejectionMessage(completion);
    expect(message).toBe("Credential command failed");
    expect(message).not.toContain("secret-command");
    expect(host.terminatedProcesses).toHaveLength(0);
  });

  it("accepts exactly 64 KiB of stdout", async () => {
    const host = new ControlledCredentialProcessHost();
    const completion = createCredentialCommandRunner(host)(commandRequest(new AbortController().signal));
    const credential = "x".repeat(SPEECH_INPUT_CREDENTIAL_MAX_STDOUT_BYTES);

    host.process.emitStdout(encode(credential));
    host.process.emitStreamClose({ code: 0 });

    await expect(completion).resolves.toBe(credential);
  });

  it("rejects stdout one byte over the configured bound and cleans up the tracked process once", async () => {
    const host = new ControlledCredentialProcessHost();
    const completion = createCredentialCommandRunner(host)(commandRequest(new AbortController().signal));

    host.process.emitStdout(encode("x".repeat(SPEECH_INPUT_CREDENTIAL_MAX_STDOUT_BYTES + 1)));

    await expect(completion).rejects.toThrow("Credential command output exceeded limit");
    expect(host.terminatedProcesses).toEqual([host.process]);
    expect(host.process.listenerCounts()).toEqual({ stdout: 0, stderr: 0, close: 0 });
    expect(host.firstDeadline().cancelCalls).toBe(1);

    host.process.emitStreamClose({ code: 0 });
    expect(host.terminatedProcesses).toHaveLength(1);
  });

  it("rejects promptly on caller abort before a never-closing process settles and ignores a late close", async () => {
    const controller = new AbortController();
    const host = new ControlledCredentialProcessHost();
    const completion = createCredentialCommandRunner(host)(commandRequest(controller.signal));

    controller.abort();

    await expect(completion).rejects.toThrow("Credential command was cancelled");
    expect(host.terminatedProcesses).toEqual([host.process]);
    host.process.emitStreamClose({ code: 0 });
    expect(host.terminatedProcesses).toHaveLength(1);
    expect(host.process.listenerCounts()).toEqual({ stdout: 0, stderr: 0, close: 0 });
  });

  it("does not spawn a command when its caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const host = new ControlledCredentialProcessHost();

    const completion = createCredentialCommandRunner(host)(commandRequest(controller.signal));

    await expect(completion).rejects.toThrow("Credential command was cancelled");
    expect(host.spawnedCommands).toEqual([]);
    expect(host.deadlines).toEqual([]);
  });

  it("does not attempt cleanup when aborting a process without a PID", async () => {
    const controller = new AbortController();
    const host = new ControlledCredentialProcessHost(new ControlledCredentialProcess({ pid: undefined }));
    const completion = createCredentialCommandRunner(host)(commandRequest(controller.signal));

    controller.abort();

    await expect(completion).rejects.toThrow("Credential command was cancelled");
    expect(host.terminatedProcesses).toHaveLength(0);
  });

  it("uses its one deadline to terminate and reject a never-closing process", async () => {
    const host = new ControlledCredentialProcessHost();
    const completion = createCredentialCommandRunner(host)(commandRequest(new AbortController().signal));

    host.firstDeadline().callback();

    await expect(completion).rejects.toThrow("Credential command timed out");
    expect(host.terminatedProcesses).toEqual([host.process]);
    expect(host.firstDeadline().cancelCalls).toBe(1);
    expect(host.process.listenerCounts()).toEqual({ stdout: 0, stderr: 0, close: 0 });
  });
});

describe.runIf(process.platform !== "win32")("default credential process host", () => {
  it("kills the tracked parent group on abort while a deliberately detached child remains outside the portable guarantee", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-speech-credential-"));
    const parentScript = join(root, "credential-parent.mjs");
    const detachedChildScript = join(root, "detached-child.mjs");
    const childPidPath = join(root, "detached-child.pid");
    const childStoppedPath = join(root, "detached-child.stopped");
    const controller = new AbortController();
    let childPid: number | undefined;
    const killSpy = vi.spyOn(process, "kill");

    try {
      await writeFile(detachedChildScript, [
        'import { rename, writeFile } from "node:fs/promises";',
        "const [pidPath, stoppedPath] = process.argv.slice(2);",
        'if (pidPath === undefined || stoppedPath === undefined) throw new Error("missing child paths");',
        "process.once(\"SIGTERM\", () => {",
        "  void (async () => {",
        '    await writeFile(`${stoppedPath}.tmp`, "stopped");',
        "    await rename(`${stoppedPath}.tmp`, stoppedPath);",
        "    process.exit(0);",
        "  })();",
        "});",
        'await writeFile(`${pidPath}.tmp`, String(process.pid));',
        "await rename(`${pidPath}.tmp`, pidPath);",
        "setInterval(() => undefined, 60_000);",
      ].join("\n"));
      await writeFile(parentScript, [
        'import { spawn } from "node:child_process";',
        "const [childScript, pidPath, stoppedPath] = process.argv.slice(2);",
        'if (childScript === undefined || pidPath === undefined || stoppedPath === undefined) throw new Error("missing child arguments");',
        "const child = spawn(process.execPath, [childScript, pidPath, stoppedPath], { detached: true, stdio: \"ignore\" });",
        "child.unref();",
        "setInterval(() => undefined, 60_000);",
      ].join("\n"));

      const childReady = waitForFileEvent(childPidPath);
      const command = [process.execPath, parentScript, detachedChildScript, childPidPath, childStoppedPath].map(quoteForPosixShell).join(" ");
      const completion = resolvePiCompatibleCredentialSource(`!${command}`, { signal: controller.signal });
      await childReady;
      const publishedChildPid = Number((await readFile(childPidPath, "utf8")).trim());
      if (!Number.isSafeInteger(publishedChildPid) || publishedChildPid <= 0) throw new Error("Detached child did not publish a PID");
      childPid = publishedChildPid;

      controller.abort();

      await expect(completion).rejects.toThrow("Credential command was cancelled");
      expect(killSpy.mock.calls.some(([target, signal]) => typeof target === "number" && target < 0 && signal === "SIGKILL")).toBe(true);
      expect(() => process.kill(publishedChildPid, 0)).not.toThrow();
    } finally {
      killSpy.mockRestore();
      controller.abort();
      if (childPid !== undefined) await stopDetachedChild(childPid, childStoppedPath);
      await rm(root, { recursive: true, force: true });
    }
  });
});
