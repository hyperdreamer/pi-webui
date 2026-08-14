import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { SpeechInputCredentialStatus } from "../../shared/apiTypes.js";

export const SPEECH_INPUT_CREDENTIAL_COMMAND_TIMEOUT_MS = 10_000;
export const SPEECH_INPUT_CREDENTIAL_MAX_STDOUT_BYTES = 64 * 1024;

export interface CredentialCommandRequest {
  command: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
}

export type CredentialCommandRunner = (request: CredentialCommandRequest) => Promise<string>;

export interface CredentialSpawnedProcess {
  readonly pid: number | undefined;
  onStdout(listener: (chunk: Uint8Array) => void): () => void;
  onStderr(listener: (chunk: Uint8Array) => void): () => void;
  onClose(listener: (result: { code: number | null; error?: Error }) => void): () => void;
}

export interface CredentialProcessHost {
  spawn(command: string): CredentialSpawnedProcess;
  terminateTrackedProcesses(process: CredentialSpawnedProcess): void;
  scheduleDeadline(callback: () => void, delayMs: number): () => void;
}

export interface ResolveCredentialOptions {
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  runCommand?: CredentialCommandRunner;
}

interface CredentialCloseResult {
  code: number | null;
  error?: Error;
}

const credentialSourceUnresolvedMessage = "Credential source could not be resolved";
const credentialCommandFailedMessage = "Credential command failed";
const credentialCommandCancelledMessage = "Credential command was cancelled";
const credentialCommandTimedOutMessage = "Credential command timed out";
const credentialCommandOutputExceededMessage = "Credential command output exceeded limit";
const credentialCommandEmptyOutputMessage = "Credential command produced no credential";
const variableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const variableNameContinuationPattern = /^[A-Za-z0-9_]$/;

class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

type ParsedCredentialSource =
  | { kind: "command"; command: string }
  | { kind: "literal" | "environment"; template: CredentialTemplate };

type CredentialTemplatePart = { type: "literal"; value: string } | { type: "variable"; name: string };

interface CredentialTemplate {
  parts: CredentialTemplatePart[];
  hasVariable: boolean;
}

interface CredentialCommandLifecycle {
  cleanupRequested: boolean;
}

export function inspectPiCompatibleCredentialSource(
  source: string | undefined,
  env?: NodeJS.ProcessEnv,
): SpeechInputCredentialStatus {
  if (source === undefined || source === "") return { configured: false, resolution: "missing" };

  const parsed = parseCredentialSource(source);
  if (parsed.kind === "command") return { configured: true, source: "command", resolution: "unchecked" };
  if (parsed.kind === "literal") return { configured: true, source: "literal", resolution: "resolved" };

  const resolved = resolveTemplate(parsed.template, env);
  return {
    configured: true,
    source: "environment",
    resolution: resolved === undefined ? "unresolved" : "resolved",
  };
}

export async function resolvePiCompatibleCredentialSource(
  source: string | undefined,
  options: ResolveCredentialOptions,
): Promise<string> {
  if (source === undefined || source === "") throw new CredentialResolutionError(credentialSourceUnresolvedMessage);

  const parsed = parseCredentialSource(source);
  if (parsed.kind === "command") {
    if (options.signal.aborted) throw new CredentialResolutionError(credentialCommandCancelledMessage);
    try {
      const value = await (options.runCommand ?? createCredentialCommandRunner())({
        command: parsed.command,
        signal: options.signal,
        timeoutMs: SPEECH_INPUT_CREDENTIAL_COMMAND_TIMEOUT_MS,
        maxStdoutBytes: SPEECH_INPUT_CREDENTIAL_MAX_STDOUT_BYTES,
      });
      if (value.trim() === "") throw new CredentialResolutionError(credentialCommandEmptyOutputMessage);
      return value;
    } catch (error: unknown) {
      if (error instanceof CredentialResolutionError) throw error;
      throw new CredentialResolutionError(credentialCommandFailedMessage);
    }
  }

  const value = resolveTemplate(parsed.template, options.env);
  if (value === undefined) throw new CredentialResolutionError(credentialSourceUnresolvedMessage);
  return value;
}

export function createCredentialCommandRunner(host: CredentialProcessHost = createDefaultCredentialProcessHost()): CredentialCommandRunner {
  return async (request) => {
    if (request.signal.aborted) throw new CredentialResolutionError(credentialCommandCancelledMessage);
    return await new Promise<string>((resolve, reject) => {
    let process: CredentialSpawnedProcess;
    try {
      process = host.spawn(request.command);
    } catch {
      reject(new CredentialResolutionError(credentialCommandFailedMessage));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    const stdoutChunks: Uint8Array[] = [];
    let removeStdout: () => void = () => undefined;
    let removeStderr: () => void = () => undefined;
    let removeClose: () => void = () => undefined;
    let cancelDeadline: () => void = () => undefined;
    const lifecycle: CredentialCommandLifecycle = { cleanupRequested: false };

    const cleanup = () => {
      lifecycle.cleanupRequested = true;
      runCleanup(removeStdout);
      runCleanup(removeStderr);
      runCleanup(removeClose);
      runCleanup(() => { request.signal.removeEventListener("abort", onAbort); });
      runCleanup(cancelDeadline);
    };

    const terminate = () => {
      if (process.pid === undefined) return;
      try {
        host.terminateTrackedProcesses(process);
      } catch {
        // Resolution ownership has settled; cleanup is best effort.
      }
    };

    const finish = (outcome: { value: string } | { error: CredentialResolutionError; terminate: boolean }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("value" in outcome) {
        resolve(outcome.value);
        return;
      }
      if (outcome.terminate) terminate();
      reject(outcome.error);
    };

    const onAbort = () => {
      finish({ error: new CredentialResolutionError(credentialCommandCancelledMessage), terminate: true });
    };

    const onStdout = (chunk: Uint8Array) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > request.maxStdoutBytes) {
        finish({ error: new CredentialResolutionError(credentialCommandOutputExceededMessage), terminate: true });
        return;
      }
      stdoutChunks.push(chunk);
    };

    const onClose = (result: CredentialCloseResult) => {
      if (result.error !== undefined || result.code !== 0) {
        finish({ error: new CredentialResolutionError(credentialCommandFailedMessage), terminate: false });
        return;
      }
      const output = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (output === "") {
        finish({ error: new CredentialResolutionError(credentialCommandEmptyOutputMessage), terminate: false });
        return;
      }
      finish({ value: output });
    };

    // Streams and close must be observed before cancellation is exposed, so an
    // immediately aborted caller cannot leave a spawned process unobserved.
    try {
      cancelDeadline = host.scheduleDeadline(() => {
        finish({ error: new CredentialResolutionError(credentialCommandTimedOutMessage), terminate: true });
      }, request.timeoutMs);
    } catch {
      finish({ error: new CredentialResolutionError(credentialCommandFailedMessage), terminate: true });
      return;
    }
    if (removeAfterSynchronousSettlement(lifecycle, cancelDeadline)) return;
    try {
      removeStdout = process.onStdout(onStdout);
      if (removeAfterSynchronousSettlement(lifecycle, removeStdout)) return;
      removeStderr = process.onStderr(() => undefined);
      removeClose = process.onClose(onClose);
      if (removeAfterSynchronousSettlement(lifecycle, removeClose)) return;
    } catch {
      finish({ error: new CredentialResolutionError(credentialCommandFailedMessage), terminate: true });
      return;
    }
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    });
  };
}

function removeAfterSynchronousSettlement(lifecycle: CredentialCommandLifecycle, remove: () => void): boolean {
  if (!lifecycle.cleanupRequested) return false;
  runCleanup(remove);
  return true;
}

function runCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Credential resolution has already chosen its terminal outcome.
  }
}

function parseCredentialSource(source: string): ParsedCredentialSource {
  if (source.startsWith("!")) return { kind: "command", command: source.slice(1) };
  const template = parseCredentialTemplate(source);
  return template.hasVariable ? { kind: "environment", template } : { kind: "literal", template };
}

function parseCredentialTemplate(source: string): CredentialTemplate {
  const parts: CredentialTemplatePart[] = [];
  let literal = "";
  let hasVariable = false;

  const appendLiteral = (value: string) => { literal += value; };
  const flushLiteral = () => {
    if (literal === "") return;
    parts.push({ type: "literal", value: literal });
    literal = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) continue;
    if (character !== "$") {
      appendLiteral(character);
      continue;
    }

    const next = source[index + 1];
    if (next === "$") {
      appendLiteral("$");
      index += 1;
      continue;
    }
    if (next === "!") {
      appendLiteral("!");
      index += 1;
      continue;
    }
    if (next === "{") {
      const closingIndex = source.indexOf("}", index + 2);
      if (closingIndex === -1) {
        appendLiteral("$");
        continue;
      }
      const name = source.slice(index + 2, closingIndex);
      if (!variableNamePattern.test(name)) {
        appendLiteral(source.slice(index, closingIndex + 1));
        index = closingIndex;
        continue;
      }
      flushLiteral();
      parts.push({ type: "variable", name });
      hasVariable = true;
      index = closingIndex;
      continue;
    }
    if (next !== undefined && variableNamePattern.test(next)) {
      let endIndex = index + 2;
      while (endIndex < source.length && variableNameContinuationPattern.test(source[endIndex] ?? "")) endIndex += 1;
      flushLiteral();
      parts.push({ type: "variable", name: source.slice(index + 1, endIndex) });
      hasVariable = true;
      index = endIndex - 1;
      continue;
    }
    appendLiteral("$");
  }

  flushLiteral();
  return { parts, hasVariable };
}

function resolveTemplate(template: CredentialTemplate | undefined, env: NodeJS.ProcessEnv | undefined): string | undefined {
  if (template === undefined) return undefined;
  let result = "";
  for (const part of template.parts) {
    if (part.type === "literal") {
      result += part.value;
      continue;
    }
    const suppliedValue = env?.[part.name];
    const processValue = process.env[part.name];
    const value = suppliedValue === undefined || suppliedValue === "" ? processValue : suppliedValue;
    if (value === undefined || value === "") return undefined;
    result += value;
  }
  return result;
}

function createDefaultCredentialProcessHost(): CredentialProcessHost {
  return {
    spawn(command) {
      const child = spawn(command, {
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      return adaptChildProcess(child);
    },
    terminateTrackedProcesses(spawnedProcess) {
      if (spawnedProcess.pid === undefined) return;
      if (process.platform !== "win32") {
        try { processKillGroup(spawnedProcess.pid); } catch { /* Best effort cleanup. */ }
        return;
      }
      try {
        const taskkill = spawn("taskkill", ["/PID", String(spawnedProcess.pid), "/T", "/F"], {
          detached: false,
          stdio: "ignore",
          windowsHide: true,
        });
        taskkill.on("error", () => undefined);
      } catch {
        // Best effort cleanup.
      }
    },
    scheduleDeadline(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => { clearTimeout(timer); };
    },
  };
}

function processKillGroup(pid: number): void {
  process.kill(-pid, "SIGKILL");
}

function adaptChildProcess(child: ChildProcess): CredentialSpawnedProcess {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) throw new Error("Credential process streams unavailable");
  let closeResult: CredentialCloseResult | undefined;
  const closeListeners = new Set<(result: CredentialCloseResult) => void>();
  const notifyClose = (result: CredentialCloseResult) => {
    if (closeResult !== undefined) return;
    closeResult = result;
    for (const listener of closeListeners) listener(result);
  };

  child.on("error", (error: Error) => { notifyClose({ code: null, error }); });
  child.on("close", (code: number | null) => { notifyClose({ code }); });

  return {
    pid: child.pid,
    onStdout(listener) {
      stdout.on("data", listener);
      return () => { stdout.off("data", listener); };
    },
    onStderr(listener) {
      stderr.on("data", listener);
      return () => { stderr.off("data", listener); };
    },
    onClose(listener) {
      closeListeners.add(listener);
      if (closeResult !== undefined) listener(closeResult);
      return () => { closeListeners.delete(listener); };
    },
  };
}
