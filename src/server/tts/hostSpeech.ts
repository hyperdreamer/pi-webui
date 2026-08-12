import type { HostSpeechStatus } from "../../shared/apiTypes.js";

export type HostSpeechProviderTerminalOutcome = "ended" | "canceled";

export interface HostSpeechProviderUtterance {
  messageId: number;
  terminal: Promise<HostSpeechProviderTerminalOutcome>;
}

export interface HostSpeechProviderSpeakRequest {
  text: string;
  voice?: string;
  rate: number;
}

export interface HostSpeechProvider {
  status(): Promise<HostSpeechStatus>;
  enqueue(input: HostSpeechProviderSpeakRequest): Promise<HostSpeechProviderUtterance>;
  cancelSelf(): Promise<void>;
  close(): Promise<void>;
}

export class HostSpeechUnavailableError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "HostSpeechUnavailableError";
  }
}
