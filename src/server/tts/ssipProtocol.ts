import { truncateHostSpeechText } from "../../shared/hostSpeech.js";
import type { HostSpeechProviderTerminalOutcome } from "./hostSpeech.js";

const MAX_REPLY_BYTES = 64 * 1024;
const SSIP_LINE = /^(\d{3})([- ])(.*)$/u;
const NON_NEGATIVE_INTEGER = /^\d+$/u;

export interface SsipFrame {
  code: number;
  message: string;
  data: string[];
}

export class SsipFrameParser {
  private input = "";
  private continuationCode: number | undefined;
  private continuationData: string[] = [];
  private retainedBytes = 0;

  push(chunk: string): SsipFrame[] {
    if (chunk.length === 0) return [];

    this.input += chunk;
    this.assertWithinBudget();
    const frames: SsipFrame[] = [];

    for (;;) {
      const lineEnd = this.input.indexOf("\n");
      if (lineEnd === -1) {
        this.assertUnterminatedLineIsValid();
        return frames;
      }

      if (lineEnd === 0 || this.input[lineEnd - 1] !== "\r") {
        this.fail("SSIP replies must use CRLF line endings");
      }

      const line = this.input.slice(0, lineEnd - 1);
      this.input = this.input.slice(lineEnd + 1);
      if (line.includes("\r")) this.fail("Malformed SSIP reply line");
      this.consumeLine(line, frames);
      this.assertWithinBudget();
    }
  }

  reset(): void {
    this.input = "";
    this.continuationCode = undefined;
    this.continuationData = [];
    this.retainedBytes = 0;
  }

  private consumeLine(line: string, frames: SsipFrame[]): void {
    const match = SSIP_LINE.exec(line);
    if (match === null) this.fail("Malformed SSIP reply line");

    const codeText = match[1];
    const separator = match[2];
    const text = match[3];
    if (codeText === undefined || separator === undefined || text === undefined) {
      this.fail("Malformed SSIP reply line");
    }

    const code = Number(codeText);
    if (separator === "-") {
      if (this.continuationCode !== undefined && this.continuationCode !== code) {
        this.fail("Mixed SSIP continuation codes");
      }
      this.continuationCode = code;
      this.continuationData.push(text);
      this.retainedBytes += byteLength(line) + 2;
      return;
    }

    if (this.continuationCode !== undefined && this.continuationCode !== code) {
      this.fail("Mixed SSIP continuation codes");
    }

    frames.push({ code, message: text, data: this.continuationData });
    this.continuationCode = undefined;
    this.continuationData = [];
    this.retainedBytes = 0;
  }

  private assertUnterminatedLineIsValid(): void {
    const carriageReturn = this.input.indexOf("\r");
    if (carriageReturn !== -1 && carriageReturn !== this.input.length - 1) {
      this.fail("SSIP replies must use CRLF line endings");
    }
  }

  private assertWithinBudget(): void {
    if (this.retainedBytes + byteLength(this.input) > MAX_REPLY_BYTES) {
      this.fail("SSIP reply exceeds the 64 KiB limit");
    }
  }

  private fail(message: string): never {
    this.reset();
    throw new Error(message);
  }
}

export function ssipDataPayload(text: string): string {
  const normalized = truncateHostSpeechText(text).replace(/\n/gu, "\r\n");
  return `${normalized.replace(/(^|\r\n)\./gu, "$1..")}\r\n.\r\n`;
}

export function ssipMessageId(frame: SsipFrame): number {
  const messageId = frame.code === 225 ? parseNonNegativeInteger(frame.data[0]) : undefined;
  if (messageId === undefined) throw new Error("Malformed SSIP message id reply");
  return messageId;
}

export function ssipTerminalEvent(frame: SsipFrame): {
  messageId: number;
  clientId: number;
  outcome: HostSpeechProviderTerminalOutcome;
} | undefined {
  const outcome = frame.code === 702 ? "ended" : frame.code === 703 ? "canceled" : undefined;
  if (outcome === undefined) return undefined;

  const messageId = parseNonNegativeInteger(frame.data[0]);
  const clientId = parseNonNegativeInteger(frame.data[1]);
  if (messageId === undefined || clientId === undefined) return undefined;
  return { messageId, clientId, outcome };
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !NON_NEGATIVE_INTEGER.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
