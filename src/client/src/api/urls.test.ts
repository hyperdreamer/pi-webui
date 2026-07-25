import { describe, expect, it } from "vitest";
import type { SessionRef } from "../../../shared/apiTypes";
import * as urls from "./urls";

type SessionHistoryPath = (session: SessionRef, machineId?: string) => string;

const session: SessionRef = { id: "session /?", cwd: "/repo with spaces/?" };

describe("sessionHistoryPath", () => {
  it("builds an application-relative export route with encoded session context", () => {
    const candidate: unknown = Reflect.get(urls, "sessionHistoryPath");

    expect(isSessionHistoryPath(candidate)).toBe(true);
    if (!isSessionHistoryPath(candidate)) return;

    expect(candidate(session, "remote /?")).toBe(
      "api/machines/remote%20%2F%3F/sessions/session%20%2F%3F/export?cwd=%2Frepo+with+spaces%2F%3F",
    );
  });
});

function isSessionHistoryPath(value: unknown): value is SessionHistoryPath {
  return typeof value === "function";
}
