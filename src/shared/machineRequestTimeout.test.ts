import { describe, expect, it } from "vitest";
import type { MachineCreateRequest, MachineUpdateRequest } from "./apiTypes";
import {
  DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
  REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS,
  effectiveMachineRequestTimeoutMs,
  validateMachineRequestTimeoutMs,
} from "./machineRequestTimeout";

describe("machine request timeout", () => {
  it("accepts inclusive machine timeout bounds without coercion", () => {
    expect(validateMachineRequestTimeoutMs(5_000)).toBe(5_000);
    expect(validateMachineRequestTimeoutMs(180_000)).toBe(180_000);
    for (const value of ["120000", null, true, 120_000.5, NaN, Infinity, 4_999, 180_001, undefined]) {
      expect(() => validateMachineRequestTimeoutMs(value)).toThrow(
        "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds",
      );
    }
  });

  it("resolves an absent machine timeout without materializing it", () => {
    const machine: { baseUrl: string; requestTimeoutMs?: number } = { baseUrl: "https://remote.example.test" };
    expect(effectiveMachineRequestTimeoutMs(machine)).toBe(DEFAULT_REMOTE_REQUEST_TIMEOUT_MS);
    expect(Object.hasOwn(machine, "requestTimeoutMs")).toBe(false);
  });

  it("keeps the remote background read budget below the default request budget", () => {
    expect(REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS).toBeLessThan(DEFAULT_REMOTE_REQUEST_TIMEOUT_MS);
  });

  it("keeps the request timeout optional in create and update payloads", () => {
    const create: MachineCreateRequest = { baseUrl: "https://remote.example.test" };
    const update: MachineUpdateRequest = { requestTimeoutMs: 60_000 };

    expect(create.requestTimeoutMs).toBeUndefined();
    expect(update).toEqual({ requestTimeoutMs: 60_000 });
  });
});
