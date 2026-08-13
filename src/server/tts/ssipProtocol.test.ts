import { describe, expect, it } from "vitest";
import {
  SsipFrameParser,
  ssipDataPayload,
  ssipMessageId,
  ssipTerminalEvent,
} from "./ssipProtocol.js";

describe("SsipFrameParser", () => {
  it("parses a complete synthesis voice list frame", () => {
    const parser = new SsipFrameParser();

    expect(parser.push("249-voice-one\ten\tmale1\r\n249-voice two\tde\t\r\n249 OK VOICES\r\n")).toEqual([
      {
        code: 249,
        message: "OK VOICES",
        data: ["voice-one\ten\tmale1", "voice two\tde\t"],
      },
    ]);
  });

  it("buffers arbitrary partial CRLF chunks until frames are complete", () => {
    const parser = new SsipFrameParser();
    const chunks = ["249-voice", "\t", "en\t\r", "\n249 OK", "\r", "\n"];

    const frames = chunks.flatMap((chunk) => parser.push(chunk));

    expect(frames).toEqual([{ code: 249, message: "OK", data: ["voice\ten\t"] }]);
  });

  it("returns command replies and independently complete terminal events in order", () => {
    const parser = new SsipFrameParser();

    expect(parser.push("702-42\r\n702-7\r\n702 END\r\n250 OK\r\n")).toEqual([
      { code: 702, message: "END", data: ["42", "7"] },
      { code: 250, message: "OK", data: [] },
    ]);
  });

  it.each([
    ["missing separator", "250OK\r\n"],
    ["non-numeric code", "ABC OK\r\n"],
    ["mixed continuation codes", "250-one\r\n251 OK\r\n"],
    ["invalid separator", "250?OK\r\n"],
  ])("rejects %s", (_name, text) => {
    const parser = new SsipFrameParser();

    expect(() => parser.push(text)).toThrow(/SSIP/i);
  });

  it("rejects over-budget unterminated reply input", () => {
    const parser = new SsipFrameParser();

    expect(() => parser.push(`250-${"x".repeat(64 * 1024)}`)).toThrow(/64 KiB/i);
  });
});

describe("SSIP frame helpers", () => {
  it("extracts the queued message id from a SPEAK data reply", () => {
    expect(ssipMessageId({ code: 225, message: "OK MESSAGE QUEUED", data: ["42"] })).toBe(42);
  });

  it.each([
    ["missing data", { code: 225, message: "OK MESSAGE QUEUED", data: [] }],
    ["wrong frame", { code: 250, message: "OK", data: ["42"] }],
    ["invalid id", { code: 225, message: "OK MESSAGE QUEUED", data: ["42x"] }],
  ])("rejects an id from %s", (_name, frame) => {
    expect(() => ssipMessageId(frame)).toThrow(/message id/i);
  });

  it("maps valid end and cancellation notifications", () => {
    expect(ssipTerminalEvent({ code: 702, message: "END", data: ["42", "7"] })).toEqual({
      messageId: 42,
      clientId: 7,
      outcome: "ended",
    });
    expect(ssipTerminalEvent({ code: 703, message: "CANCEL", data: ["43", "7"] })).toEqual({
      messageId: 43,
      clientId: 7,
      outcome: "canceled",
    });
  });

  it.each([
    { code: 701, message: "BEGIN", data: ["42", "7"] },
    { code: 702, message: "END", data: ["x", "7"] },
    { code: 703, message: "CANCEL", data: ["42"] },
    { code: 703, message: "CANCEL", data: ["42", "7x"] },
  ])("ignores invalid terminal events", (frame) => {
    expect(ssipTerminalEvent(frame)).toBeUndefined();
  });

  it("normalizes, dot-stuffs, and terminates payload data", () => {
    expect(ssipDataPayload("first\n.\n..third")).toBe("first\r\n..\r\n...third\r\n.\r\n");
    expect(ssipDataPayload("one\r\ntwo\rthree\u0000")).toBe("one\r\ntwo\r\nthree\r\n.\r\n");
  });

  it("truncates long data through the shared host-speech projection", () => {
    const payload = ssipDataPayload("x".repeat(4_100));

    expect(payload).toHaveLength(4_005);
    expect(payload.endsWith("\r\n.\r\n")).toBe(true);
  });
});
