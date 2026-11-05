// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("workspaceFileViewUrl", () => {
  let base: HTMLBaseElement;

  beforeEach(() => {
    vi.stubEnv("BASE_URL", "./");
    base = document.createElement("base");
    base.href = "https://gateway.example/";
    document.head.append(base);
  });

  afterEach(() => {
    base.remove();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("builds an encoded browser-ready file view URL on the current origin", () => {
    const result = urls.workspaceFileViewUrl("project /?", "workspace ?/", "dir/a ?#%+.html", { machineId: "remote /?" });

    expect(result).toBe(
      "https://gateway.example/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view?path=dir%2Fa+%3F%23%25%2B.html",
    );
    const url = new URL(result);
    expect(url.origin).toBe("https://gateway.example");
    expect(url.pathname).toBe("/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view");
    expect(url.searchParams.get("path")).toBe("dir/a ?#%+.html");
    expect(url.hash).toBe("");
  });

  it("defaults file view URLs to the local machine", () => {
    const result = urls.workspaceFileViewUrl("p", "w", "a.html");

    expect(result).toBe("https://gateway.example/api/machines/local/projects/p/workspaces/w/file/view?path=a.html");
    expect(new URL(result).hash).toBe("");
  });

  it("resolves file view URLs exactly once beneath the effective nested base", () => {
    base.href = "https://gateway.example/tools/pi/";

    expect(urls.workspaceFileViewUrl("project /?", "workspace ?/", "dir/a ?#%+.html", { machineId: "remote /?" })).toBe(
      "https://gateway.example/tools/pi/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view?path=dir%2Fa+%3F%23%25%2B.html",
    );
  });
});
