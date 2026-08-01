import type { SessionUiEvent } from "./sessionSocket";

export const DEFAULT_MAX_PENDING_STREAM_EVENT_RUNS = 128;
export const DEFAULT_MAX_PENDING_STREAM_BYTES = 262_144;

export interface StreamEventBufferLimits {
  maxEventRuns?: number;
  maxBytes?: number;
}

export interface DrainedStreamEvents {
  events: SessionUiEvent[];
  resyncRequired: boolean;
}

type BufferedStreamEvent = Extract<
  SessionUiEvent,
  { type: "assistant.delta" | "assistant.thinking.delta" | "shell.chunk" | "tool.update" }
>;
type ToolUpdateEvent = Extract<BufferedStreamEvent, { type: "tool.update" }>;

interface AssistantDeltaRun {
  type: "assistant.delta";
  chunks: string[];
  seq: number | undefined;
  bytes: number;
}

interface ThinkingDeltaRun {
  type: "assistant.thinking.delta";
  chunks: string[];
  seq: number | undefined;
  bytes: number;
}

type TextRun = AssistantDeltaRun | ThinkingDeltaRun;

interface ShellRun {
  type: "shell.chunk";
  chunks: string[];
  seq: number | undefined;
  bytes: number;
}

interface ToolRun {
  type: "tool.update";
  toolCallId: string;
  latest: Omit<ToolUpdateEvent, "seq">;
  seq: number | undefined;
  bytes: number;
}

type BufferedRun = TextRun | ShellRun | ToolRun;

const textEncoder = new TextEncoder();

export function isBufferedStreamEvent(event: SessionUiEvent): boolean {
  return event.type === "assistant.delta"
    || event.type === "assistant.thinking.delta"
    || event.type === "shell.chunk"
    || event.type === "tool.update";
}

export class StreamEventBuffer {
  private readonly maxEventRuns: number;
  private readonly maxBytes: number;
  private runs: BufferedRun[] = [];
  private pendingByteCount = 0;
  private resyncRequired = false;

  constructor(limits: StreamEventBufferLimits = {}) {
    this.maxEventRuns = limits.maxEventRuns ?? DEFAULT_MAX_PENDING_STREAM_EVENT_RUNS;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_PENDING_STREAM_BYTES;
  }

  get eventCount(): number {
    return this.runs.length;
  }

  get pendingBytes(): number {
    return this.pendingByteCount;
  }

  enqueue(event: BufferedStreamEvent): void {
    if (this.resyncRequired || !isBufferedStreamEvent(event)) return;

    const eventBytes = serializedEventBytes(event);
    const previous = this.runs.at(-1);
    const mergesWithPrevious = previous !== undefined && canMerge(previous, event);
    const nextEventCount = this.runs.length + (mergesWithPrevious ? 0 : 1);
    const nextRunBytes = previous !== undefined && mergesWithPrevious
      ? mergedRunBytes(previous, event, eventBytes)
      : eventBytes;
    const bytesToReplace = previous !== undefined && mergesWithPrevious ? previous.bytes : 0;
    const nextBytes = this.pendingByteCount - bytesToReplace + nextRunBytes;

    if (nextEventCount > this.maxEventRuns || nextBytes > this.maxBytes) {
      this.markResyncRequired();
      return;
    }

    if (mergesWithPrevious) {
      mergeIntoRun(previous, event, nextRunBytes);
      this.pendingByteCount = nextBytes;
      return;
    }

    this.runs.push(createRun(event, eventBytes));
    this.pendingByteCount = nextBytes;
  }

  drain(): DrainedStreamEvents {
    if (this.resyncRequired) {
      this.resyncRequired = false;
      return { events: [], resyncRequired: true };
    }

    const events: SessionUiEvent[] = [];
    for (const run of this.runs) events.push(materializeRun(run));
    this.runs = [];
    this.pendingByteCount = 0;
    return { events, resyncRequired: false };
  }

  clear(): void {
    this.runs = [];
    this.pendingByteCount = 0;
    this.resyncRequired = false;
  }

  private markResyncRequired(): void {
    this.runs = [];
    this.pendingByteCount = 0;
    this.resyncRequired = true;
  }
}

function canMerge(run: BufferedRun, event: BufferedStreamEvent): boolean {
  switch (run.type) {
    case "assistant.delta": return event.type === "assistant.delta";
    case "assistant.thinking.delta": return event.type === "assistant.thinking.delta";
    case "shell.chunk": return event.type === "shell.chunk";
    case "tool.update": return event.type === "tool.update" && run.toolCallId === event.toolCallId;
  }
}

function createRun(event: BufferedStreamEvent, bytes: number): BufferedRun {
  if (event.type === "assistant.delta" || event.type === "assistant.thinking.delta") {
    return { type: event.type, chunks: [event.text], seq: event.seq, bytes };
  }
  if (event.type === "shell.chunk") {
    return { type: event.type, chunks: [event.chunk], seq: event.seq, bytes };
  }
  return {
    type: event.type,
    toolCallId: event.toolCallId,
    latest: toolUpdatePayload(event),
    seq: event.seq,
    bytes,
  };
}

function mergedRunBytes(run: BufferedRun, event: BufferedStreamEvent, eventBytes: number): number {
  if (run.type === "tool.update" && event.type === "tool.update") {
    const retained = withSeq(toolUpdatePayload(event), highestSeq(run.seq, event.seq));
    return serializedEventBytes(retained);
  }
  return run.bytes + eventBytes;
}

function mergeIntoRun(run: BufferedRun, event: BufferedStreamEvent, bytes: number): void {
  if (run.type === "assistant.delta" && event.type === "assistant.delta") {
    run.chunks.push(event.text);
    run.seq = highestSeq(run.seq, event.seq);
    run.bytes = bytes;
    return;
  }
  if (run.type === "assistant.thinking.delta" && event.type === "assistant.thinking.delta") {
    run.chunks.push(event.text);
    run.seq = highestSeq(run.seq, event.seq);
    run.bytes = bytes;
    return;
  }
  if (run.type === "shell.chunk" && event.type === "shell.chunk") {
    run.chunks.push(event.chunk);
    run.seq = highestSeq(run.seq, event.seq);
    run.bytes = bytes;
    return;
  }
  if (run.type === "tool.update" && event.type === "tool.update") {
    run.latest = toolUpdatePayload(event);
    run.seq = highestSeq(run.seq, event.seq);
    run.bytes = bytes;
  }
}

function materializeRun(run: BufferedRun): SessionUiEvent {
  if (run.type === "assistant.delta") {
    return withSeq({ type: run.type, text: run.chunks.join("") }, run.seq);
  }
  if (run.type === "assistant.thinking.delta") {
    return withSeq({ type: run.type, text: run.chunks.join("") }, run.seq);
  }
  if (run.type === "shell.chunk") {
    return withSeq({ type: run.type, chunk: run.chunks.join("") }, run.seq);
  }
  if ("latest" in run) return withSeq(run.latest, run.seq);
  throw new Error("unreachable buffered stream run");
}

function toolUpdatePayload(event: ToolUpdateEvent): Omit<ToolUpdateEvent, "seq"> {
  return {
    type: event.type,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    text: event.text,
    ...(event.content === undefined ? {} : { content: event.content }),
    ...(event.details === undefined ? {} : { details: event.details }),
  };
}

function withSeq(event: SessionUiEvent, seq: number | undefined): SessionUiEvent {
  return seq === undefined ? event : { ...event, seq };
}

function highestSeq(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function serializedEventBytes(event: SessionUiEvent): number {
  return textEncoder.encode(JSON.stringify(event)).byteLength;
}
