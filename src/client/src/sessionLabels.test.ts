import { describe, expect, it } from "vitest";
import { shortSessionId } from "./sessionLabels";

describe("shortSessionId", () => {
  it("uses the random-looking suffix of UUIDv7 session ids", () => {
    expect(shortSessionId("019f22c5-d53e-7489-997f-fce1e570a202")).toBe("e570a202");
  });

  it("keeps short ids intact", () => {
    expect(shortSessionId("abc123")).toBe("abc123");
  });
});
