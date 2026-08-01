import { describe, expect, it } from "vitest";
import type { SessionUiEvent } from "./sessionSocket";
import {
  DEFAULT_MAX_PENDING_STREAM_BYTES,
  DEFAULT_MAX_PENDING_STREAM_EVENT_RUNS,
  DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS,
  StreamEventBuffer,
  isBufferedStreamEvent,
} from "./streamEventBuffer";

type BufferedStreamEvent = Extract<
  SessionUiEvent,
  { type: "assistant.delta" | "assistant.thinking.delta" | "shell.chunk" | "tool.update" }
>;

const utf8ByteLength = (event: SessionUiEvent): number => new TextEncoder().encode(JSON.stringify(event)).byteLength;

describe("isBufferedStreamEvent", () => {
  it("accepts only high-frequency stream events", () => {
    expect(isBufferedStreamEvent({ type: "assistant.delta", text: "a" })).toBe(true);
    expect(isBufferedStreamEvent({ type: "assistant.thinking.delta", text: "a" })).toBe(true);
    expect(isBufferedStreamEvent({ type: "shell.chunk", chunk: "a" })).toBe(true);
    expect(isBufferedStreamEvent({ type: "tool.update", toolName: "read", toolCallId: "c1", text: "a" })).toBe(true);
    expect(isBufferedStreamEvent({ type: "tool.start", toolName: "read", toolCallId: "c1", summary: "" })).toBe(false);
  });
});

describe("StreamEventBuffer defaults", () => {
  it("exports the required run and byte limits", () => {
    expect(DEFAULT_MAX_PENDING_STREAM_EVENT_RUNS).toBe(128);
    expect(DEFAULT_MAX_PENDING_STREAM_BYTES).toBe(262_144);
  });

  it("exports the tool-update key limit", () => {
    expect(DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS).toBe(64);
  });
});

describe("StreamEventBuffer", () => {
  const bashSnapshot = (toolCallId: string, bytes: number): BufferedStreamEvent => ({
    type: "tool.update",
    toolName: "bash",
    toolCallId,
    text: "x".repeat(bytes),
  });

  it("materializes text chunks once at drain and preserves the highest seq", () => {
    const events: BufferedStreamEvent[] = [
      { type: "assistant.delta", text: "Hel", seq: 4 },
      { type: "assistant.delta", text: "lo ", seq: 5 },
      { type: "assistant.delta", text: "world", seq: 6 },
    ];
    const buffer = new StreamEventBuffer();

    for (const event of events) buffer.enqueue(event);

    expect(buffer.eventCount).toBe(1);
    expect(buffer.drain()).toEqual({
      events: [{ type: "assistant.delta", text: "Hello world", seq: 6 }],
      resyncRequired: false,
    });
    expect(buffer.eventCount).toBe(0);
    expect(buffer.pendingBytes).toBe(0);
  });

  it("preserves ordering across thinking, text, and shell type transitions", () => {
    const buffer = new StreamEventBuffer();

    buffer.enqueue({ type: "assistant.delta", text: "a" });
    buffer.enqueue({ type: "assistant.thinking.delta", text: "t" });
    buffer.enqueue({ type: "assistant.delta", text: "b" });
    buffer.enqueue({ type: "shell.chunk", chunk: "line 1\n" });
    buffer.enqueue({ type: "shell.chunk", chunk: "line 2\n" });
    buffer.enqueue({ type: "assistant.thinking.delta", text: "u" });

    expect(buffer.eventCount).toBe(5);
    expect(buffer.drain()).toEqual({
      events: [
        { type: "assistant.delta", text: "a" },
        { type: "assistant.thinking.delta", text: "t" },
        { type: "assistant.delta", text: "b" },
        { type: "shell.chunk", chunk: "line 1\nline 2\n" },
        { type: "assistant.thinking.delta", text: "u" },
      ],
      resyncRequired: false,
    });
  });

  it("keeps the latest same-tool update without treating different tools as barriers", () => {
    const buffer = new StreamEventBuffer();

    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: "partial 1", content: "old", details: { step: 1 }, seq: 1 });
    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: "partial 2", content: "new", details: { step: 2 }, seq: 2 });
    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other", seq: 3 });
    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: "after barrier", seq: 4 });

    expect(buffer.eventCount).toBe(2);
    expect(buffer.drain()).toEqual({
      events: [
        { type: "tool.update", toolName: "bash", toolCallId: "c1", text: "after barrier", seq: 4 },
        { type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other", seq: 3 },
      ],
      resyncRequired: false,
    });
  });

  it("does not resync when concurrent tools interleave full-size snapshots", () => {
    // Reproduces the tab-freeze surge: upstream bash emits a cumulative 50KB
    // snapshot per update, so interleaved tools used to cross the 256KB budget
    // after 6-8 events and trigger a full session resync loop.
    for (const concurrency of [2, 6, 12]) {
      const buffer = new StreamEventBuffer();
      for (let round = 0; round < 40; round++) {
        for (let tool = 0; tool < concurrency; tool++) {
          buffer.enqueue(bashSnapshot(`c${String(tool)}`, 50 * 1024));
        }
      }
      const drained = buffer.drain();
      expect(drained.resyncRequired).toBe(false);
      expect(drained.events).toHaveLength(concurrency);
    }
  });

  it("retains only the latest snapshot per tool call and the highest seq", () => {
    const buffer = new StreamEventBuffer();

    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: "first", seq: 7 });
    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other", seq: 8 });
    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: "latest", content: "new", details: { step: 2 }, seq: 3 });

    expect(buffer.eventCount).toBe(2);
    expect(buffer.drain()).toEqual({
      events: [
        { type: "tool.update", toolName: "bash", toolCallId: "c1", text: "latest", content: "new", details: { step: 2 }, seq: 7 },
        { type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other", seq: 8 },
      ],
      resyncRequired: false,
    });
  });

  it("does not charge keyed tool updates against the accumulating byte budget", () => {
    const buffer = new StreamEventBuffer({ maxBytes: 200 });

    buffer.enqueue(bashSnapshot("c1", 50 * 1024));
    buffer.enqueue(bashSnapshot("c2", 50 * 1024));

    expect(buffer.pendingBytes).toBe(0);
    expect(buffer.drain().resyncRequired).toBe(false);
  });

  it("does not charge keyed tool updates against the event-run limit", () => {
    const buffer = new StreamEventBuffer({ maxEventRuns: 2, maxBytes: 10_000 });

    buffer.enqueue({ type: "assistant.delta", text: "a" });
    buffer.enqueue({ type: "shell.chunk", chunk: "s" });
    for (let tool = 0; tool < 10; tool++) buffer.enqueue(bashSnapshot(`c${String(tool)}`, 16));

    expect(buffer.drain().resyncRequired).toBe(false);
  });

  it("resyncs when distinct streaming tool calls exceed the key limit", () => {
    const buffer = new StreamEventBuffer({ maxToolUpdateKeys: 3 });

    for (let tool = 0; tool < 4; tool++) buffer.enqueue(bashSnapshot(`c${String(tool)}`, 16));

    expect(buffer.eventCount).toBe(0);
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: true });
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: false });
  });

  it("accepts exactly the configured tool-update key limit", () => {
    const buffer = new StreamEventBuffer({ maxToolUpdateKeys: 3 });

    for (let tool = 0; tool < 3; tool++) buffer.enqueue(bashSnapshot(`c${String(tool)}`, 16));

    expect(buffer.eventCount).toBe(3);
    expect(buffer.drain().resyncRequired).toBe(false);
  });

  it("drains accumulating runs before keyed tool updates", () => {
    const buffer = new StreamEventBuffer();

    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: "tool", seq: 1 });
    buffer.enqueue({ type: "assistant.delta", text: "text", seq: 2 });
    buffer.enqueue({ type: "shell.chunk", chunk: "shell", seq: 3 });

    expect(buffer.drain()).toEqual({
      events: [
        { type: "assistant.delta", text: "text", seq: 2 },
        { type: "shell.chunk", chunk: "shell", seq: 3 },
        { type: "tool.update", toolName: "bash", toolCallId: "c1", text: "tool", seq: 1 },
      ],
      resyncRequired: false,
    });
  });

  it("clear removes keyed tool updates", () => {
    const buffer = new StreamEventBuffer();

    buffer.enqueue(bashSnapshot("c1", 16));
    buffer.clear();

    expect(buffer.eventCount).toBe(0);
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: false });
  });

  it("accepts exactly the configured event-run limit", () => {
    const buffer = new StreamEventBuffer({ maxEventRuns: 2, maxBytes: 10_000 });

    buffer.enqueue({ type: "assistant.delta", text: "a" });
    buffer.enqueue({ type: "assistant.thinking.delta", text: "t" });

    expect(buffer.eventCount).toBe(2);
    expect(buffer.drain()).toEqual({
      events: [
        { type: "assistant.delta", text: "a" },
        { type: "assistant.thinking.delta", text: "t" },
      ],
      resyncRequired: false,
    });
  });

  it("returns one resync marker on event-run overflow and resumes after drain", () => {
    const buffer = new StreamEventBuffer({ maxEventRuns: 2, maxBytes: 10_000 });

    buffer.enqueue({ type: "assistant.delta", text: "a" });
    buffer.enqueue({ type: "assistant.thinking.delta", text: "t" });
    buffer.enqueue({ type: "shell.chunk", chunk: "s" });
    buffer.enqueue({ type: "assistant.delta", text: "ignored before drain" });

    expect(buffer.eventCount).toBe(0);
    expect(buffer.pendingBytes).toBe(0);
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: true });
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: false });

    buffer.enqueue({ type: "assistant.delta", text: "accepted after drain" });
    expect(buffer.drain()).toEqual({
      events: [{ type: "assistant.delta", text: "accepted after drain" }],
      resyncRequired: false,
    });
  });

  it("returns one resync marker on byte overflow and ignores inputs until drain", () => {
    const first: SessionUiEvent = { type: "assistant.delta", text: "a" };
    const second: SessionUiEvent = { type: "assistant.delta", text: "b" };
    const buffer = new StreamEventBuffer({
      maxEventRuns: 128,
      maxBytes: utf8ByteLength(first) + utf8ByteLength(second) - 1,
    });

    buffer.enqueue(first);
    buffer.enqueue(second);
    buffer.enqueue({ type: "assistant.delta", text: "ignored before drain" });

    expect(buffer.drain()).toEqual({ events: [], resyncRequired: true });
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: false });

    buffer.enqueue({ type: "assistant.delta", text: "accepted after drain" });
    expect(buffer.drain()).toEqual({
      events: [{ type: "assistant.delta", text: "accepted after drain" }],
      resyncRequired: false,
    });
  });

  it("resyncs when a multibyte input is one UTF-8 byte over the byte limit", () => {
    const event: BufferedStreamEvent = { type: "assistant.delta", text: "é" };
    const serializedLength = JSON.stringify(event).length;
    const eventBytes = utf8ByteLength(event);
    const buffer = new StreamEventBuffer({ maxBytes: eventBytes - 1 });

    expect(eventBytes).toBe(serializedLength + 1);

    buffer.enqueue(event);

    expect(buffer.eventCount).toBe(0);
    expect(buffer.pendingBytes).toBe(0);
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: true });
  });

  it("clear removes pending events, byte accounting, and a pending resync marker", () => {
    const buffer = new StreamEventBuffer({ maxEventRuns: 1, maxBytes: 10_000 });

    buffer.enqueue({ type: "assistant.delta", text: "a" });
    buffer.enqueue({ type: "assistant.thinking.delta", text: "overflow" });
    buffer.clear();

    expect(buffer.eventCount).toBe(0);
    expect(buffer.pendingBytes).toBe(0);
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: false });

    buffer.enqueue({ type: "shell.chunk", chunk: "accepted after clear" });
    expect(buffer.drain()).toEqual({
      events: [{ type: "shell.chunk", chunk: "accepted after clear" }],
      resyncRequired: false,
    });
  });

  it("keeps many chunks in one run before drain and materializes their text correctly", () => {
    const buffer = new StreamEventBuffer();
    const chunks = Array.from({ length: 100 }, (_, index) => `chunk-${String(index)};`);

    for (const chunk of chunks) buffer.enqueue({ type: "shell.chunk", chunk });

    expect(buffer.eventCount).toBe(1);
    expect(buffer.drain()).toEqual({
      events: [{ type: "shell.chunk", chunk: chunks.join("") }],
      resyncRequired: false,
    });
  });
});
