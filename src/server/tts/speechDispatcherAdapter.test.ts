import { describe, expect, it, vi } from "vitest";
import { HostSpeechUnavailableError } from "./hostSpeech.js";
import {
  SpeechDispatcherAdapter,
  type DeadlineScheduler,
  type SsipTransport,
  type SsipTransportFactory,
} from "./speechDispatcherAdapter.js";

const UNAVAILABLE_MESSAGE = "Speech Dispatcher is unavailable on the local gateway.";

describe("SpeechDispatcherAdapter", () => {
  it("reports non-Linux platforms unavailable without opening a transport", async () => {
    const factory = vi.fn<SsipTransportFactory>();
    const adapter = new SpeechDispatcherAdapter({ platform: "darwin", createTransport: factory });

    await expect(adapter.status()).resolves.toEqual({
      available: false,
      reason: UNAVAILABLE_MESSAGE,
      voices: [],
    });
    await expect(adapter.enqueue({ text: "hello", rate: 0 })).rejects.toThrow(HostSpeechUnavailableError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses the XDG runtime socket and initializes a Linux connection in protocol order", async () => {
    const fixture = scriptedFactory([initializationReplies(), ["249 OK\r\n"]]);
    const adapter = new SpeechDispatcherAdapter({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      createTransport: fixture.factory,
    });

    const status = adapter.status();
    await fixture.connected();
    expect(fixture.paths).toEqual(["/run/user/1000/speech-dispatcher/speechd.sock"]);

    await expect(status).resolves.toEqual({ available: true, voices: [] });
    expect(fixture.transport.writes).toEqual([
      "SET SELF CLIENT_NAME pi-webui:tts:main\r\n",
      "HISTORY GET CLIENT_ID\r\n",
      "SET SELF NOTIFICATION BEGIN on\r\n",
      "SET SELF NOTIFICATION END on\r\n",
      "SET SELF NOTIFICATION CANCEL on\r\n",
      "LIST SYNTHESIS_VOICES\r\n",
    ]);
  });

  it("accepts Speech Dispatcher command-specific initialization reply codes", async () => {
    const fixture = scriptedFactory([
      [
        "208 OK\r\n",
        "245-7\r\n245 OK\r\n",
        "220 OK\r\n",
        "220 OK\r\n",
        "220 OK\r\n",
      ],
      ["249 OK\r\n"],
    ]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });

    await expect(adapter.status()).resolves.toEqual({ available: true, voices: [] });
  });

  it("falls back to cache/home and accepts only absolute Unix SPEECHD_ADDRESS overrides", async () => {
    const cacheFixture = scriptedFactory([initializationReplies(), ["249 OK\r\n"]]);
    const cacheAdapter = new SpeechDispatcherAdapter({
      platform: "linux",
      env: { XDG_CACHE_HOME: "/cache" },
      createTransport: cacheFixture.factory,
    });
    const cacheStatus = cacheAdapter.status();
    await cacheFixture.connected();
    expect(cacheFixture.paths).toEqual(["/cache/speech-dispatcher/speechd.sock"]);
    await cacheStatus;

    const overrideFixture = scriptedFactory([initializationReplies(), ["249 OK\r\n"]]);
    const overrideAdapter = new SpeechDispatcherAdapter({
      platform: "linux",
      env: { SPEECHD_ADDRESS: "unix_socket:/tmp/speechd.sock" },
      createTransport: overrideFixture.factory,
    });
    const overrideStatus = overrideAdapter.status();
    await overrideFixture.connected();
    expect(overrideFixture.paths).toEqual(["/tmp/speechd.sock"]);
    await overrideStatus;

    for (const address of ["inet:127.0.0.1:6560", "unix:relative.sock", "unix_socket:relative.sock"]) {
      const invalidFactory = vi.fn<SsipTransportFactory>();
      const invalidAdapter = new SpeechDispatcherAdapter({
        platform: "linux",
        env: { SPEECHD_ADDRESS: address },
        createTransport: invalidFactory,
      });
      await expect(invalidAdapter.status()).resolves.toEqual({ available: false, reason: UNAVAILABLE_MESSAGE, voices: [] });
      expect(invalidFactory).not.toHaveBeenCalled();
    }
  });

  it("refreshes status voice lists and caches normalized named voices only for one connection", async () => {
    const fixture = scriptedFactory([
      initializationReplies(),
      ["249-Alice\ten-US\tfemale1\r\n249-Bob\tde\t\r\n249 OK\r\n"],
      ["249-Bob\tde\t\r\n249 OK\r\n"],
      ["249-Bob\tde\t\r\n249 OK\r\n"],
    ]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });
    const initialStatus = adapter.status();
    await fixture.connected();
    await expect(initialStatus).resolves.toEqual({
      available: true,
      voices: [
        { name: "Alice", language: "en-US", variant: "female1" },
        { name: "Bob", language: "de" },
      ],
    });

    const refreshedStatus = adapter.status();
    await expect(refreshedStatus).resolves.toEqual({ available: true, voices: [{ name: "Bob", language: "de" }] });

    await expect(adapter.enqueue({ text: "hello", voice: "Alice", rate: 0 })).rejects.toThrow(/voice/i);
    expect(fixture.transport.writes).not.toContain("SET SELF SYNTHESIS_VOICE Alice\r\n");
  });

  it("refreshes the voice list for the first named utterance after status populated the connection cache", async () => {
    const fixture = scriptedFactory([
      initializationReplies(),
      ["249-Alice\ten\t\r\n249 OK\r\n"],
      ["249-Bob\tde\t\r\n249 OK\r\n"],
    ]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });

    await adapter.status();

    await expect(adapter.enqueue({ text: "hello", voice: "Alice", rate: 0 })).rejects.toThrow(/voice/i);
    expect(fixture.transport.writes.filter((write) => write === "LIST SYNTHESIS_VOICES\r\n")).toHaveLength(2);
  });

  it("returns detached voice-list snapshots", async () => {
    const fixture = scriptedFactory([
      initializationReplies(),
      ["249-Alice\ten\t\r\n249 OK\r\n"],
      ["249-Alice\ten\t\r\n249 OK\r\n"],
    ]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });

    const first = await adapter.status();
    const firstVoice = first.voices[0];
    if (firstVoice === undefined) throw new Error("Expected a voice");
    firstVoice.name = "changed";
    const second = await adapter.status();

    expect(second.voices).toEqual([{ name: "Alice", language: "en" }]);
  });

  it("ignores nonterminal 7xx notifications while waiting for a command reply", async () => {
    const fixture = scriptedFactory([
      initializationReplies(),
      ["701-42\r\n701-7\r\n701 BEGIN\r\n249-Alice\ten\t\r\n249 OK\r\n"],
    ]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });

    await expect(adapter.status()).resolves.toEqual({ available: true, voices: [{ name: "Alice", language: "en" }] });
  });

  it("gets voices for the first named utterance and writes priority, rate, voice, SPEAK, and dot-stuffed data", async () => {
    const fixture = scriptedFactory([
      initializationReplies(),
      ["249-Alice\ten\tfemale1\r\n249 OK\r\n"],
      ["202 OK\r\n"],
      ["203 OK\r\n"],
      ["209 OK\r\n"],
      ["230 OK\r\n"],
      ["225-42\r\n225 OK MESSAGE QUEUED\r\n"],
    ]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });
    const utterancePromise = adapter.enqueue({ text: "first\n.", voice: "Alice", rate: -25 });
    await fixture.connected();

    const utterance = await utterancePromise;
    expect(utterance.messageId).toBe(42);
    expect(fixture.transport.writes).toEqual([
      "SET SELF CLIENT_NAME pi-webui:tts:main\r\n",
      "HISTORY GET CLIENT_ID\r\n",
      "SET SELF NOTIFICATION BEGIN on\r\n",
      "SET SELF NOTIFICATION END on\r\n",
      "SET SELF NOTIFICATION CANCEL on\r\n",
      "LIST SYNTHESIS_VOICES\r\n",
      "SET SELF PRIORITY text\r\n",
      "SET SELF RATE -25\r\n",
      "SET SELF SYNTHESIS_VOICE Alice\r\n",
      "SPEAK\r\n",
      "first\r\n..\r\n.\r\n",
    ]);
    fixture.transport.feed("702-42\r\n702-7\r\n702 END\r\n");
    await expect(utterance.terminal).resolves.toBe("ended");
  });

  it("rejects invalid rate and unknown voice before serializing untrusted values", async () => {
    const fixture = scriptedFactory([initializationReplies(), ["249-Alice\ten\t\r\n249 OK\r\n"]]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });
    await expect(adapter.enqueue({ text: "hello", rate: 100.5 })).rejects.toThrow(/rate/i);
    expect(fixture.factory).not.toHaveBeenCalled();

    const unknownVoice = adapter.enqueue({ text: "hello", voice: "Not listed", rate: 0 });
    await fixture.connected();
    await expect(unknownVoice).rejects.toThrow(/voice/i);
    expect(fixture.transport.writes).not.toContain("SET SELF SYNTHESIS_VOICE Not listed\r\n");
  });

  it("reconnects before a default-voice utterance after a named voice", async () => {
    const fixture = scriptedFactory([
      initializationReplies(),
      ["249-Alice\ten\t\r\n249 OK\r\n"],
      ["202 OK\r\n"],
      ["203 OK\r\n"],
      ["209 OK\r\n"],
      ["230 OK\r\n"],
      ["225-1\r\n225 OK\r\n"],
    ], [
      initializationReplies(),
      ["202 OK\r\n"],
      ["203 OK\r\n"],
      ["230 OK\r\n"],
      ["225-2\r\n225 OK\r\n"],
    ]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });
    const named = adapter.enqueue({ text: "named", voice: "Alice", rate: 0 });
    await fixture.connected();
    const namedUtterance = await named;
    fixture.transport.feed("702-1\r\n702-7\r\n702 END\r\n");
    await namedUtterance.terminal;

    const defaultVoice = adapter.enqueue({ text: "default", rate: 0 });
    await fixture.connected(1);
    const defaultUtterance = await defaultVoice;
    expect(fixture.paths).toHaveLength(2);
    const secondTransport = fixture.transports[1];
    if (secondTransport === undefined) throw new Error("Expected second transport");
    expect(secondTransport.writes).not.toContain("SET SELF SYNTHESIS_VOICE Alice\r\n");
    secondTransport.feed("702-2\r\n702-7\r\n702 END\r\n");
    await defaultUtterance.terminal;
  });

  it("consumes early and late terminal cancellation events by message id", async () => {
    const earlyFixture = scriptedFactory([
      initializationReplies(),
      ["202 OK\r\n"],
      ["203 OK\r\n"],
      ["230 OK\r\n"],
      ["703-42\r\n703-7\r\n703 CANCEL\r\n225-42\r\n225 OK\r\n"],
    ]);
    const earlyAdapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: earlyFixture.factory });
    const early = earlyAdapter.enqueue({ text: "hello", rate: 0 });
    await earlyFixture.connected();
    await earlyFixture.transport.waitForWrite("hello\r\n.\r\n");
    await expect((await early).terminal).resolves.toBe("canceled");

    const lateFixture = scriptedFactory([
      initializationReplies(),
      ["202 OK\r\n"],
      ["203 OK\r\n"],
      ["230 OK\r\n"],
      ["225-43\r\n225 OK\r\n"],
    ]);
    const lateAdapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: lateFixture.factory });
    const late = lateAdapter.enqueue({ text: "hello", rate: 0 });
    await lateFixture.connected();
    await lateFixture.transport.waitForWrite("hello\r\n.\r\n");
    const lateUtterance = await late;
    lateFixture.transport.feed("703-43\r\n703-999\r\n703 CANCEL\r\n");
    await expect(lateUtterance.terminal).resolves.toBe("canceled");
  });

  it("sends only CANCEL self and waits for its 213 acknowledgement", async () => {
    const fixture = scriptedFactory([initializationReplies(), ["249 OK\r\n"], ["213 OK\r\n"]]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });
    const warmup = adapter.status();
    await fixture.connected();
    await warmup;

    const canceled = adapter.cancelSelf();
    await expect(canceled).resolves.toBeUndefined();
    expect(fixture.transport.writes).toContain("CANCEL self\r\n");
    expect(fixture.transport.writes).not.toContain("CANCEL all\r\n");
  });

  it("rejects pending work and reconnects when a socket drops", async () => {
    const fixture = scriptedFactory([
      initializationReplies(),
      ["202 OK\r\n"],
    ], [
      initializationReplies(),
      ["249 OK\r\n"],
    ]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });
    const dropped = adapter.enqueue({ text: "hello", rate: 0 });
    await fixture.connected();
    await fixture.transport.waitForWrite("SET SELF RATE 0\r\n");
    fixture.transport.closeFromPeer(new Error("socket lost"));
    await expect(dropped).rejects.toThrow(HostSpeechUnavailableError);

    const retry = adapter.status();
    await fixture.connected(1);
    await expect(retry).resolves.toEqual({ available: true, voices: [] });
  });

  it("applies connect, command, cancel, and terminal deadlines through the injected scheduler", async () => {
    const connectFixture = deferredTransportFactory();
    const connectScheduler = manualScheduler();
    const connectAdapter = new SpeechDispatcherAdapter({
      platform: "linux",
      createTransport: connectFixture.factory,
      scheduleDeadline: connectScheduler.schedule,
    });
    const connectStatus = connectAdapter.status();
    await connectFixture.started();
    expect(connectScheduler.delays).toContain(2_000);
    connectScheduler.fire(2_000);
    await expect(connectStatus).resolves.toEqual({ available: false, reason: UNAVAILABLE_MESSAGE, voices: [] });
    connectFixture.resolve();
    await Promise.resolve();
    expect(connectFixture.transport.closed).toBe(true);

    const commandFixture = scriptedFactory([[]]);
    const commandScheduler = manualScheduler();
    const commandAdapter = new SpeechDispatcherAdapter({
      platform: "linux",
      createTransport: commandFixture.factory,
      scheduleDeadline: commandScheduler.schedule,
    });
    const commandStatus = commandAdapter.status();
    await commandFixture.connected();
    await commandFixture.transport.waitForWrite("SET SELF CLIENT_NAME pi-webui:tts:main\r\n");
    expect(commandScheduler.delays).toContain(3_000);
    commandScheduler.fire(3_000);
    await expect(commandStatus).resolves.toEqual({ available: false, reason: UNAVAILABLE_MESSAGE, voices: [] });

    const cancelFixture = scriptedFactory([initializationReplies(), ["249 OK\r\n"]]);
    const cancelScheduler = manualScheduler();
    const cancelAdapter = new SpeechDispatcherAdapter({
      platform: "linux",
      createTransport: cancelFixture.factory,
      scheduleDeadline: cancelScheduler.schedule,
    });
    const warmup = cancelAdapter.status();
    await cancelFixture.connected();
    await warmup;
    const cancel = cancelAdapter.cancelSelf();
    await cancelFixture.transport.waitForWrite("CANCEL self\r\n");
    cancelScheduler.fire(3_000);
    await expect(cancel).rejects.toThrow(/timed out/i);

    const terminalFixture = scriptedFactory([
      initializationReplies(),
      ["202 OK\r\n"],
      ["203 OK\r\n"],
      ["230 OK\r\n"],
      ["225-42\r\n225 OK\r\n"],
    ]);
    const terminalScheduler = manualScheduler();
    const terminalAdapter = new SpeechDispatcherAdapter({
      platform: "linux",
      createTransport: terminalFixture.factory,
      scheduleDeadline: terminalScheduler.schedule,
    });
    const utterancePromise = terminalAdapter.enqueue({ text: "four", rate: 0 });
    await terminalFixture.connected();
    const utterance = await utterancePromise;
    expect(terminalScheduler.delays).toContain(30_300);
    terminalScheduler.fire(30_300);
    await expect(utterance.terminal).rejects.toThrow(/timed out/i);
  });

  it("closes idempotently without emitting global cancellation", async () => {
    const fixture = scriptedFactory([initializationReplies(), ["249 OK\r\n"]]);
    const adapter = new SpeechDispatcherAdapter({ platform: "linux", createTransport: fixture.factory });
    const warmup = adapter.status();
    await fixture.connected();
    await warmup;

    await adapter.close();
    await adapter.close();
    expect(fixture.transport.closed).toBe(true);
    expect(fixture.transport.writes.some((write) => write.includes("CANCEL all"))).toBe(false);
  });
});

class ScriptedSsipTransport implements SsipTransport {
  readonly writes: string[] = [];
  closed = false;
  private readonly replies: string[] = [];
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly writeWaiters = new Map<string, (() => void)[]>();

  write(data: string): void {
    if (this.closed) throw new Error("transport is closed");
    this.writes.push(data);
    for (const resolve of this.writeWaiters.get(data) ?? []) resolve();
    this.writeWaiters.delete(data);
    const reply = this.replies.shift();
    if (reply !== undefined) queueMicrotask(() => { this.feed(reply); });
  }

  close(): void {
    this.closed = true;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => { this.dataListeners.delete(listener); };
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  feed(frameText: string): void {
    for (const listener of this.dataListeners) listener(frameText);
  }

  closeFromPeer(error?: Error): void {
    this.closed = true;
    for (const listener of this.closeListeners) listener(error);
  }

  queueReplies(...replies: string[]): void {
    this.replies.push(...replies);
  }

  waitForWrite(data: string): Promise<void> {
    if (this.writes.includes(data)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.writeWaiters.get(data) ?? [];
      waiters.push(resolve);
      this.writeWaiters.set(data, waiters);
    });
  }
}

function scriptedFactory(...connectionReplyPlans: (readonly (readonly string[])[])[]): {
  factory: SsipTransportFactory;
  transports: ScriptedSsipTransport[];
  transport: ScriptedSsipTransport;
  paths: string[];
  connected(index?: number): Promise<void>;
} {
  const transports: ScriptedSsipTransport[] = [];
  const paths: string[] = [];
  const waiters: (() => void)[] = [];
  const factory = vi.fn<SsipTransportFactory>((path) => {
    paths.push(path);
    const transport = new ScriptedSsipTransport();
    transport.queueReplies(...(connectionReplyPlans[transports.length] ?? []).flat());
    transports.push(transport);
    waiters.shift()?.();
    return Promise.resolve(transport);
  });
  return {
    factory,
    transports,
    get transport() {
      const transport = transports[0];
      if (transport === undefined) throw new Error("Expected a transport");
      return transport;
    },
    paths,
    connected(index = 0): Promise<void> {
      if (transports[index] !== undefined) return Promise.resolve();
      return new Promise((resolve) => { waiters.push(resolve); });
    },
  };
}

function deferredTransportFactory(): {
  factory: SsipTransportFactory;
  transport: ScriptedSsipTransport;
  started(): Promise<void>;
  resolve(): void;
} {
  const transport = new ScriptedSsipTransport();
  let resolveTransport!: (value: SsipTransport) => void;
  let resolveStarted!: () => void;
  const promise = new Promise<SsipTransport>((resolve) => { resolveTransport = resolve; });
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  return {
    factory: vi.fn<SsipTransportFactory>(() => {
      resolveStarted();
      return promise;
    }),
    transport,
    started: () => started,
    resolve() { resolveTransport(transport); },
  };
}

function manualScheduler(): { schedule: DeadlineScheduler; delays: number[]; fire(delayMs: number): void } {
  const pending = new Map<number, (() => void)[]>();
  const delays: number[] = [];
  return {
    delays,
    schedule(callback, delayMs) {
      delays.push(delayMs);
      const callbacks = pending.get(delayMs) ?? [];
      callbacks.push(callback);
      pending.set(delayMs, callbacks);
      return () => {
        const index = callbacks.indexOf(callback);
        if (index !== -1) callbacks.splice(index, 1);
      };
    },
    fire(delayMs) {
      const callbacks = pending.get(delayMs) ?? [];
      pending.delete(delayMs);
      for (const callback of callbacks) callback();
    },
  };
}

function initializationReplies(): string[] {
  return [
    "208 OK\r\n",
    "245-7\r\n245 OK\r\n",
    "220 OK\r\n",
    "220 OK\r\n",
    "220 OK\r\n",
  ];
}
