import { createConnection } from "node:net";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { HostSpeechStatus, HostSpeechVoice } from "../../shared/apiTypes.js";
import {
  HostSpeechUnavailableError,
  type HostSpeechProvider,
  type HostSpeechProviderSpeakRequest,
  type HostSpeechProviderTerminalOutcome,
  type HostSpeechProviderUtterance,
} from "./hostSpeech.js";
import { SsipFrameParser, ssipDataPayload, ssipMessageId, ssipTerminalEvent, type SsipFrame } from "./ssipProtocol.js";

const UNAVAILABLE_MESSAGE = "Speech Dispatcher is unavailable on the local gateway.";
const CONNECT_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 3_000;
const CANCEL_TIMEOUT_MS = 3_000;
const MAX_TERMINAL_TIMEOUT_MS = 300_000;
const TERMINAL_TIMEOUT_BASE_MS = 30_000;
const TERMINAL_TIMEOUT_PER_CHAR_MS = 75;
const EARLY_TERMINAL_LIMIT = 64;

function noop(): void {
  // Intentionally empty until a deadline is installed.
}

export interface SsipTransport {
  write(data: string): void;
  close(): void;
  onData(listener: (chunk: string) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
}

export type SsipTransportFactory = (socketPath: string) => Promise<SsipTransport>;
export type DeadlineScheduler = (callback: () => void, delayMs: number) => () => void;

export interface SpeechDispatcherAdapterOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  createTransport?: SsipTransportFactory;
  scheduleDeadline?: DeadlineScheduler;
}

interface PendingReply {
  expectedCode: number;
  resolve: (frame: SsipFrame) => void;
  reject: (error: Error) => void;
  cancelDeadline: () => void;
}

interface PendingUtterance {
  resolve: (outcome: HostSpeechProviderTerminalOutcome) => void;
  reject: (error: Error) => void;
  cancelDeadline: () => void;
}

export class SpeechDispatcherAdapter implements HostSpeechProvider {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly createTransport: SsipTransportFactory;
  private readonly scheduleDeadline: DeadlineScheduler;
  private transport: SsipTransport | undefined;
  private unsubscribeData: (() => void) | undefined;
  private unsubscribeClose: (() => void) | undefined;
  private connecting: Promise<SsipTransport> | undefined;
  private initializing: Promise<void> | undefined;
  private commandChain: Promise<void> = Promise.resolve();
  private pendingReply: PendingReply | undefined;
  private readonly parser = new SsipFrameParser();
  private readonly pendingUtterances = new Map<number, PendingUtterance>();
  private readonly earlyTerminals = new Map<number, HostSpeechProviderTerminalOutcome>();
  private voices: readonly Readonly<HostSpeechVoice>[] | undefined;
  private hasNamedVoice = false;
  private hasRefreshedNamedVoiceCache = false;
  private isClosed = false;

  constructor(options: SpeechDispatcherAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? this.env["HOME"] ?? homedir();
    this.createTransport = options.createTransport ?? createNodeSsipTransport;
    this.scheduleDeadline = options.scheduleDeadline ?? scheduleTimeout;
  }

  async status(): Promise<HostSpeechStatus> {
    if (!this.supported()) return unavailableStatus();

    try {
      const voices = await this.runSerialized(async () => this.listVoices());
      return { available: true, voices: voices.map(copyVoice) };
    } catch {
      return unavailableStatus();
    }
  }

  async enqueue(input: HostSpeechProviderSpeakRequest): Promise<HostSpeechProviderUtterance> {
    validateRate(input.rate);
    if (!this.supported()) throw unavailableError();

    try {
      return await this.runSerialized(async () => this.enqueueSerialized(input));
    } catch (error) {
      if (error instanceof HostSpeechUnavailableError || isInputError(error)) throw error;
      throw unavailableError();
    }
  }

  async cancelSelf(): Promise<void> {
    if (!this.supported()) throw unavailableError();

    try {
      await this.runSerialized(async () => {
        await this.ensureInitialized();
        await this.sendCommand("CANCEL self", 213, CANCEL_TIMEOUT_MS);
      });
    } catch (error) {
      if (error instanceof HostSpeechUnavailableError) throw error;
      throw normalizeError(error);
    }
  }

  close(): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    this.isClosed = true;
    this.resetConnection(new Error("Speech Dispatcher connection was closed."));
    return Promise.resolve();
  }

  private async enqueueSerialized(input: HostSpeechProviderSpeakRequest): Promise<HostSpeechProviderUtterance> {
    if (input.voice === undefined && this.hasNamedVoice) this.resetConnection(new Error("Reset named speech voice."));
    await this.ensureInitialized();

    if (input.voice !== undefined) {
      const voices = this.hasRefreshedNamedVoiceCache && this.voices !== undefined
        ? this.voices
        : await this.listVoices();
      this.hasRefreshedNamedVoiceCache = true;
      if (!voices.some((voice) => voice.name === input.voice)) {
        throw new InputError(`Unknown Speech Dispatcher voice: ${input.voice}`);
      }
    }

    await this.sendCommand("SET SELF PRIORITY text", 202, COMMAND_TIMEOUT_MS);
    await this.sendCommand(`SET SELF RATE ${String(input.rate)}`, 203, COMMAND_TIMEOUT_MS);
    if (input.voice !== undefined) {
      await this.sendCommand(`SET SELF SYNTHESIS_VOICE ${input.voice}`, 209, COMMAND_TIMEOUT_MS);
      this.hasNamedVoice = true;
    }
    await this.sendCommand("SPEAK", 230, COMMAND_TIMEOUT_MS);
    const reply = await this.sendData(ssipDataPayload(input.text), 225, COMMAND_TIMEOUT_MS);
    const messageId = ssipMessageId(reply);
    return this.registerUtterance(messageId, input.text.length);
  }

  private async listVoices(): Promise<readonly Readonly<HostSpeechVoice>[]> {
    await this.ensureInitialized();
    const reply = await this.sendCommand("LIST SYNTHESIS_VOICES", 249, COMMAND_TIMEOUT_MS);
    const voices = normalizeVoices(reply.data);
    this.voices = voices;
    return voices;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.isClosed) throw new Error("Speech Dispatcher adapter is closed.");
    if (this.initializing !== undefined) return this.initializing;

    this.initializing = this.initialize();
    try {
      await this.initializing;
    } finally {
      if (this.transport === undefined) this.initializing = undefined;
    }
  }

  private async initialize(): Promise<void> {
    await this.ensureTransport();
    await this.sendCommand("SET SELF CLIENT_NAME pi-webui:tts:main", 208, COMMAND_TIMEOUT_MS);
    const clientIdReply = await this.sendCommand("HISTORY GET CLIENT_ID", 245, COMMAND_TIMEOUT_MS);
    if (parseClientId(clientIdReply.data[0]) === undefined) {
      throw new Error("Malformed Speech Dispatcher client id reply.");
    }
    await this.sendCommand("SET SELF NOTIFICATION BEGIN on", 220, COMMAND_TIMEOUT_MS);
    await this.sendCommand("SET SELF NOTIFICATION END on", 220, COMMAND_TIMEOUT_MS);
    await this.sendCommand("SET SELF NOTIFICATION CANCEL on", 220, COMMAND_TIMEOUT_MS);
  }

  private async ensureTransport(): Promise<SsipTransport> {
    if (this.transport !== undefined) return this.transport;
    if (this.connecting !== undefined) return this.connecting;

    const socketPath = resolveSocketPath(this.env, this.homeDir);
    if (socketPath === undefined) throw unavailableError();
    this.connecting = withDeadline(
      this.createTransport(socketPath),
      CONNECT_TIMEOUT_MS,
      this.scheduleDeadline,
      () => {
        this.transport?.close();
        this.resetConnection(new Error("Speech Dispatcher connection timed out."));
      },
      "Speech Dispatcher connection timed out.",
    );
    try {
      const transport = await this.connecting;
      if (this.isClosed) {
        transport.close();
        throw new Error("Speech Dispatcher adapter is closed.");
      }
      this.transport = transport;
      this.unsubscribeData = transport.onData((chunk) => { this.receiveData(chunk); });
      this.unsubscribeClose = transport.onClose((error) => { this.resetConnection(error ?? new Error("Speech Dispatcher connection closed.")); });
      return transport;
    } finally {
      this.connecting = undefined;
    }
  }

  private sendCommand(command: string, expectedCode: number, timeoutMs: number): Promise<SsipFrame> {
    return this.send(command + "\r\n", expectedCode, timeoutMs);
  }

  private sendData(data: string, expectedCode: number, timeoutMs: number): Promise<SsipFrame> {
    return this.send(data, expectedCode, timeoutMs);
  }

  private send(data: string, expectedCode: number, timeoutMs: number): Promise<SsipFrame> {
    const transport = this.transport;
    if (transport === undefined) return Promise.reject(new Error("Speech Dispatcher is not connected."));
    if (this.pendingReply !== undefined) return Promise.reject(new Error("Speech Dispatcher command queue invariant failed."));

    return new Promise<SsipFrame>((resolve, reject) => {
      const pending: PendingReply = {
        expectedCode,
        resolve,
        reject,
        cancelDeadline: noop,
      };
      pending.cancelDeadline = this.scheduleDeadline(() => {
        if (this.pendingReply !== pending) return;
        this.resetConnection(new Error("Speech Dispatcher command timed out."));
      }, timeoutMs);
      this.pendingReply = pending;
      try {
        transport.write(data);
      } catch (error) {
        this.resetConnection(normalizeError(error));
      }
    });
  }

  private receiveData(chunk: string): void {
    let frames: SsipFrame[];
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      this.resetConnection(normalizeError(error));
      return;
    }

    for (const frame of frames) this.routeFrame(frame);
  }

  private routeFrame(frame: SsipFrame): void {
    const terminal = ssipTerminalEvent(frame);
    if (terminal !== undefined) {
      this.routeTerminal(terminal.messageId, terminal.outcome);
      return;
    }
    if (frame.code >= 700 && frame.code < 800) return;

    const pending = this.pendingReply;
    if (pending === undefined) {
      this.resetConnection(new Error("Unexpected Speech Dispatcher reply."));
      return;
    }
    this.pendingReply = undefined;
    pending.cancelDeadline();
    if (frame.code !== pending.expectedCode) {
      const error = new Error(`Unexpected Speech Dispatcher reply code ${String(frame.code)}.`);
      pending.reject(error);
      this.resetConnection(error);
      return;
    }
    pending.resolve(frame);
  }

  private registerUtterance(messageId: number, textLength: number): HostSpeechProviderUtterance {
    let resolveTerminal!: (outcome: HostSpeechProviderTerminalOutcome) => void;
    let rejectTerminal!: (error: Error) => void;
    const terminal = new Promise<HostSpeechProviderTerminalOutcome>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    const pending: PendingUtterance = {
      resolve: resolveTerminal,
      reject: rejectTerminal,
      cancelDeadline: noop,
    };
    const timeoutMs = Math.min(MAX_TERMINAL_TIMEOUT_MS, TERMINAL_TIMEOUT_BASE_MS + textLength * TERMINAL_TIMEOUT_PER_CHAR_MS);
    pending.cancelDeadline = this.scheduleDeadline(() => {
      if (this.pendingUtterances.get(messageId) !== pending) return;
      this.resetConnection(new Error("Speech Dispatcher terminal event timed out."));
    }, timeoutMs);
    this.pendingUtterances.set(messageId, pending);
    const earlyTerminal = this.earlyTerminals.get(messageId);
    if (earlyTerminal !== undefined) {
      this.earlyTerminals.delete(messageId);
      this.resolveTerminal(messageId, earlyTerminal);
    }
    return { messageId, terminal };
  }

  private routeTerminal(messageId: number, outcome: HostSpeechProviderTerminalOutcome): void {
    if (this.pendingUtterances.has(messageId)) {
      this.resolveTerminal(messageId, outcome);
      return;
    }
    this.earlyTerminals.set(messageId, outcome);
    if (this.earlyTerminals.size > EARLY_TERMINAL_LIMIT) {
      const oldest = this.earlyTerminals.keys().next().value;
      if (oldest !== undefined) this.earlyTerminals.delete(oldest);
    }
  }

  private resolveTerminal(messageId: number, outcome: HostSpeechProviderTerminalOutcome): void {
    const pending = this.pendingUtterances.get(messageId);
    if (pending === undefined) return;
    this.pendingUtterances.delete(messageId);
    pending.cancelDeadline();
    queueMicrotask(() => { pending.resolve(outcome); });
  }

  private resetConnection(error: Error): void {
    const transport = this.transport;
    this.transport = undefined;
    this.connecting = undefined;
    this.initializing = undefined;
    this.voices = undefined;
    this.hasNamedVoice = false;
    this.hasRefreshedNamedVoiceCache = false;
    this.parser.reset();
    this.unsubscribeData?.();
    this.unsubscribeClose?.();
    this.unsubscribeData = undefined;
    this.unsubscribeClose = undefined;
    if (transport !== undefined) transport.close();

    const pendingReply = this.pendingReply;
    this.pendingReply = undefined;
    if (pendingReply !== undefined) {
      pendingReply.cancelDeadline();
      pendingReply.reject(error);
    }
    for (const pending of this.pendingUtterances.values()) {
      pending.cancelDeadline();
      pending.reject(error);
    }
    this.pendingUtterances.clear();
    this.earlyTerminals.clear();
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandChain.then(operation, operation);
    this.commandChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private supported(): boolean {
    return this.platform === "linux" && resolveSocketPath(this.env, this.homeDir) !== undefined;
  }
}

function unavailableStatus(): HostSpeechStatus {
  return { available: false, reason: UNAVAILABLE_MESSAGE, voices: [] };
}

function unavailableError(): HostSpeechUnavailableError {
  return new HostSpeechUnavailableError(UNAVAILABLE_MESSAGE);
}

function validateRate(rate: number): void {
  if (!Number.isInteger(rate) || rate < -100 || rate > 100) {
    throw new InputError("Speech Dispatcher rate must be an integer from -100 to 100.");
  }
}

function normalizeVoices(data: readonly string[]): readonly Readonly<HostSpeechVoice>[] {
  const voices: Readonly<HostSpeechVoice>[] = [];
  for (const line of data) {
    const parts = line.split("\t");
    const name = parts[0];
    const language = parts[1];
    const variant = parts[2];
    if (name === undefined || language === undefined || variant === undefined || name === "" || language === "") continue;
    voices.push(Object.freeze({ name, language, ...(variant === "" ? {} : { variant }) }));
  }
  return Object.freeze(voices);
}

function copyVoice(voice: Readonly<HostSpeechVoice>): HostSpeechVoice {
  return { ...voice };
}

function parseClientId(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const clientId = Number(value);
  return Number.isSafeInteger(clientId) ? clientId : undefined;
}

function resolveSocketPath(env: NodeJS.ProcessEnv, homeDir: string): string | undefined {
  const address = env["SPEECHD_ADDRESS"];
  if (address !== undefined) {
    const match = /^(?:unix|unix_socket):(\/.*)$/u.exec(address);
    return match?.[1];
  }
  const base = env["XDG_RUNTIME_DIR"] ?? env["XDG_CACHE_HOME"] ?? `${homeDir}/.cache`;
  return `${base}/speech-dispatcher/speechd.sock`;
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => { clearTimeout(handle); };
}

function withDeadline(
  promise: Promise<SsipTransport>,
  delayMs: number,
  schedule: DeadlineScheduler,
  onTimeout: () => void,
  message: string,
): Promise<SsipTransport> {
  let timedOut = false;
  return new Promise<SsipTransport>((resolve, reject) => {
    const cancel = schedule(() => {
      timedOut = true;
      onTimeout();
      reject(new Error(message));
    }, delayMs);
    promise.then(
      (value) => {
        cancel();
        if (timedOut) {
          value.close();
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        reject(normalizeError(error));
      },
    );
  });
}

function createNodeSsipTransport(socketPath: string): Promise<SsipTransport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const decoder = new StringDecoder("utf8");
    let connected = false;
    const dataListeners = new Set<(chunk: string) => void>();
    const closeListeners = new Set<(error?: Error) => void>();
    let closeError: Error | undefined;

    const transport: SsipTransport = {
      write(data) { socket.write(data, "utf8"); },
      close() { socket.destroy(); },
      onData(listener) {
        dataListeners.add(listener);
        return () => { dataListeners.delete(listener); };
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => { closeListeners.delete(listener); };
      },
    };

    socket.once("connect", () => {
      connected = true;
      resolve(transport);
    });
    socket.on("error", (error) => {
      if (!connected) reject(error);
      else closeError = error;
    });
    socket.on("data", (chunk: Buffer) => {
      const data = decoder.write(chunk);
      for (const listener of dataListeners) listener(data);
    });
    socket.on("close", () => {
      const tail = decoder.end();
      if (tail !== "") {
        for (const listener of dataListeners) listener(tail);
      }
      if (connected) {
        for (const listener of closeListeners) listener(closeError);
      }
    });
  });
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class InputError extends Error {}

function isInputError(error: unknown): error is InputError {
  return error instanceof InputError;
}
