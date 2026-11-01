export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 120_000;
export const MIN_REMOTE_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_REMOTE_REQUEST_TIMEOUT_MS = 180_000;
export const REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS = 20_000;

const INVALID_TIMEOUT_MESSAGE = "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds";

export function validateMachineRequestTimeoutMs(value: unknown): number {
  if (
    typeof value === "number"
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= MIN_REMOTE_REQUEST_TIMEOUT_MS
    && value <= MAX_REMOTE_REQUEST_TIMEOUT_MS
  ) {
    return value;
  }
  throw new Error(INVALID_TIMEOUT_MESSAGE);
}

export function effectiveMachineRequestTimeoutMs(machine: { requestTimeoutMs?: number }): number {
  return machine.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
}
