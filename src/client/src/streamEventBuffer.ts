import type { SessionUiEvent } from "./sessionSocket";

export const DEFAULT_MAX_PENDING_STREAM_EVENT_RUNS = 128;
export const DEFAULT_MAX_PENDING_STREAM_BYTES = 262_144;
export const DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS = 64;

export interface StreamEventBufferLimits {
  maxEventRuns?: number;
  maxBytes?: number;
  maxToolUpdateKeys?: number;
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
}

type AccumulatingRun = TextRun | ShellRun;

const textEncoder = new TextEncoder();

export function isBufferedStreamEvent(event: SessionUiEvent): event is BufferedStreamEvent {
  return event.type === "assistant.delta"
    || event.type === "assistant.thinking.delta"
    || event.type === "shell.chunk"
    || event.type === "tool.update";
}

export class StreamEventBuffer {
  private readonly maxEventRuns: number;
  private readonly maxBytes: number;
  private readonly maxToolUpdateKeys: number;
  private runs: AccumulatingRun[] = [];
  private readonly toolUpdateRuns = new Map<string, ToolRun>();
  private pendingByteCount = 0;
  private resyncRequired = false;

  constructor(limits: StreamEventBufferLimits = {}) {
    this.maxEventRuns = limits.maxEventRuns ?? DEFAULT_MAX_PENDING_STREAM_EVENT_RUNS;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_PENDING_STREAM_BYTES;
    this.maxToolUpdateKeys = limits.maxToolUpdateKeys ?? DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS;
  }

  get eventCount(): number {
    return this.runs.length + this.toolUpdateRuns.size;
  }

  get pendingBytes(): number {
    return this.pendingByteCount;
  }

  enqueue(event: BufferedStreamEvent): void {
    if (this.resyncRequired || !isBufferedStreamEvent(event)) return;
    if (event.type === "tool.update") {
      this.enqueueToolUpdate(event);
      return;
    }
    this.enqueueAccumulating(event);
  }

  /**
   * `tool.update` carries a cumulative snapshot, so only the newest one per
   * tool call matters. Replacement is bounded by distinct concurrently
   * streaming tool calls, not by elapsed time, so it is capped by key count
   * rather than charged against the falling-behind byte budget. Charging bytes
   * here caused a false overload at ~6 concurrent tools, and the resulting
   * resync loop froze the tab.
   */
  private enqueueToolUpdate(event: ToolUpdateEvent): void {
    const existing = this.toolUpdateRuns.get(event.toolCallId);
    if (existing !== undefined) {
      existing.latest = toolUpdatePayload(event);
      existing.seq = highestSeq(existing.seq, event.seq);
      return;
    }
    if (this.toolUpdateRuns.size + 1 > this.maxToolUpdateKeys) {
      this.markResyncRequired();
      return;
    }
    this.toolUpdateRuns.set(event.toolCallId, {
      type: "tool.update",
      toolCallId: event.toolCallId,
      latest: toolUpdatePayload(event),
      seq: event.seq,
    });
  }

  private enqueueAccumulating(event: Exclude<BufferedStreamEvent, ToolUpdateEvent>): void {
    const previous = this.runs.at(-1);
    const mergesWithPrevious = previous !== undefined && canMerge(previous, event);
    const nextEventCount = this.runs.length + (mergesWithPrevious ? 0 : 1);
    const nextRunBytes = mergesWithPrevious
      ? mergedRunBytes(previous, event)
      : serializedEventBytes(event);
    // `mergedRunBytes` loses its `eventBytes` parameter here, because only
    // accumulating runs remain and they keep charging the full serialized
    // event exactly as before.
    const bytesToReplace = mergesWithPrevious ? previous.bytes : 0;
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

    this.runs.push(createRun(event, nextRunBytes));
    this.pendingByteCount = nextBytes;
  }

  drain(): DrainedStreamEvents {
    if (this.resyncRequired) {
      this.resyncRequired = false;
      return { events: [], resyncRequired: true };
    }

    const events: SessionUiEvent[] = [];
    for (const run of this.runs) events.push(materializeRun(run));
    // Keyed tool updates drain after accumulating runs. Reordering is safe:
    // `applyTranscriptEvent` resolves `tool.update` by `toolCallId`, and every
    // order-dependent event (`tool.start`, `tool.end`, `shell.start`,
    // `shell.end`, `message.append`, `message.end`) is unbuffered and forces a
    // flush before it applies.
    for (const run of this.toolUpdateRuns.values()) events.push(withSeq(run.latest, run.seq));
    this.reset();
    return { events, resyncRequired: false };
  }

  clear(): void {
    this.reset();
    this.resyncRequired = false;
  }

  private reset(): void {
    this.runs = [];
    this.toolUpdateRuns.clear();
    this.pendingByteCount = 0;
  }

  private markResyncRequired(): void {
    this.reset();
    this.resyncRequired = true;
  }
}

function canMerge(
  run: AccumulatingRun,
  event: Exclude<BufferedStreamEvent, ToolUpdateEvent>,
): boolean {
  switch (run.type) {
    case "assistant.delta": return event.type === "assistant.delta";
    case "assistant.thinking.delta": return event.type === "assistant.thinking.delta";
    case "shell.chunk": return event.type === "shell.chunk";
  }
}

function createRun(
  event: Exclude<BufferedStreamEvent, ToolUpdateEvent>,
  bytes: number,
): AccumulatingRun {
  if (event.type === "assistant.delta" || event.type === "assistant.thinking.delta") {
    return { type: event.type, chunks: [event.text], seq: event.seq, bytes };
  }
  return { type: event.type, chunks: [event.chunk], seq: event.seq, bytes };
}

function mergedRunBytes(
  run: AccumulatingRun,
  event: Exclude<BufferedStreamEvent, ToolUpdateEvent>,
): number {
  return run.bytes + serializedEventBytes(event);
}

function mergeIntoRun(
  run: AccumulatingRun,
  event: Exclude<BufferedStreamEvent, ToolUpdateEvent>,
  bytes: number,
): void {
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
  }
}

function materializeRun(run: AccumulatingRun): SessionUiEvent {
  if (run.type === "assistant.delta") {
    return withSeq({ type: run.type, text: run.chunks.join("") }, run.seq);
  }
  if (run.type === "assistant.thinking.delta") {
    return withSeq({ type: run.type, text: run.chunks.join("") }, run.seq);
  }
  return withSeq({ type: run.type, chunk: run.chunks.join("") }, run.seq);
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
