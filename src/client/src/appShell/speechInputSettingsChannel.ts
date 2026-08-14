import { resolveAppUrl } from "../appUrl";
import { isCanonicalLowercaseUuid } from "../../../shared/speechInput";

const CHANNEL_PREFIX = "pi-webui:speech-input-settings:";

export interface SpeechInputSettingsChannelLike {
  publish(revision: string): void;
  close(): void;
}

export interface SpeechInputSettingsBroadcastChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface SpeechInputSettingsChannelOptions {
  resolveAppUrl?: (path: string) => string;
  createBroadcastChannel?: (name: string) => SpeechInputSettingsBroadcastChannel | undefined;
}

/**
 * Browser boundary for cross-tab speech-settings invalidation. It intentionally
 * carries only a revision; the app shell refetches the redacted snapshot.
 */
export class SpeechInputSettingsChannel implements SpeechInputSettingsChannelLike {
  private channel: SpeechInputSettingsBroadcastChannel | undefined;
  private closed = false;
  private lastRevision: string | undefined;

  constructor(
    private readonly onRevision: (revision: string) => void,
    options: SpeechInputSettingsChannelOptions = {},
  ) {
    const appUrl = options.resolveAppUrl ?? resolveAppUrl;
    const createBroadcastChannel = options.createBroadcastChannel ?? browserBroadcastChannel;
    try {
      this.channel = createBroadcastChannel(`${CHANNEL_PREFIX}${appUrl("")}`);
      if (this.channel !== undefined) this.channel.onmessage = (event) => { this.handleMessage(event.data); };
    } catch {
      this.channel = undefined;
    }
  }

  publish(revision: string): void {
    if (this.closed || !isRevision(revision)) return;
    this.lastRevision = revision;
    try {
      this.channel?.postMessage({ contractVersion: 1, revision });
    } catch {
      // Cross-tab notification is optional; the local snapshot is already current.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const channel = this.channel;
    this.channel = undefined;
    if (channel === undefined) return;
    channel.onmessage = null;
    channel.close();
  }

  private handleMessage(value: unknown): void {
    if (this.closed || !isSpeechInputSettingsChannelMessage(value)) return;
    if (value.revision === this.lastRevision) return;
    this.lastRevision = value.revision;
    this.onRevision(value.revision);
  }
}

function browserBroadcastChannel(name: string): SpeechInputSettingsBroadcastChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  return new BroadcastChannel(name);
}

function isSpeechInputSettingsChannelMessage(value: unknown): value is { contractVersion: 1; revision: string } {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  return value["contractVersion"] === 1 && isRevision(value["revision"]);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && isCanonicalLowercaseUuid(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
