import { describe, expect, it } from "vitest";
import {
  shouldRetainStarterNotice,
  starterFailureNotice,
  starterNoticeVisibleText,
  starterPolicyBlockedNotice,
} from "./starterNotice";

const scope = { machineId: "local", workspaceId: "workspace-a" };
const otherWorkspace = { machineId: "local", workspaceId: "workspace-b" };
const otherMachine = { machineId: "remote-a", workspaceId: "workspace-a" };

describe("starterPolicyBlockedNotice", () => {
  it("captures no message, so its text can only be read live", () => {
    expect(starterPolicyBlockedNotice(scope)).toEqual({ kind: "policy-blocked", scope });
  });
});

describe("starterNoticeVisibleText", () => {
  it("reads a policy-blocked message from the live reason", () => {
    const notice = starterPolicyBlockedNotice(scope);
    expect(starterNoticeVisibleText(notice, scope, "Choose a valid model tier")).toBe("Choose a valid model tier");
    expect(starterNoticeVisibleText(notice, scope, "A different live reason")).toBe("A different live reason");
  });

  it("shows nothing for a policy-blocked notice once the live reason is gone", () => {
    expect(starterNoticeVisibleText(starterPolicyBlockedNotice(scope), scope, undefined)).toBeUndefined();
    expect(starterNoticeVisibleText(starterPolicyBlockedNotice(scope), scope, "")).toBeUndefined();
  });

  it("shows the captured message for a failure, with no live reason available", () => {
    const notice = starterFailureNotice("start-failed", "Could not start the session. offline", scope);
    expect(starterNoticeVisibleText(notice, scope, undefined)).toBe("Could not start the session. offline");
  });

  it("ignores a live reason when the notice carries its own message", () => {
    const notice = starterFailureNotice("defaults-failed", "Could not load starter defaults. offline", scope);
    expect(starterNoticeVisibleText(notice, scope, "Choose a valid model tier")).toBe("Could not load starter defaults. offline");
  });

  it("shows nothing outside the notice's own machine and workspace", () => {
    const blocked = starterPolicyBlockedNotice(scope);
    const failed = starterFailureNotice("start-failed", "offline", scope);
    expect(starterNoticeVisibleText(blocked, otherWorkspace, "Choose a valid model tier")).toBeUndefined();
    expect(starterNoticeVisibleText(blocked, otherMachine, "Choose a valid model tier")).toBeUndefined();
    expect(starterNoticeVisibleText(failed, otherWorkspace, undefined)).toBeUndefined();
    expect(starterNoticeVisibleText(failed, undefined, undefined)).toBeUndefined();
  });

  it("shows nothing when there is no notice", () => {
    expect(starterNoticeVisibleText(undefined, scope, "Choose a valid model tier")).toBeUndefined();
  });
});

describe("shouldRetainStarterNotice", () => {
  it("drops a policy-blocked notice as soon as the live reason is repaired", () => {
    const notice = starterPolicyBlockedNotice(scope);
    expect(shouldRetainStarterNotice(notice, scope, "Choose a valid model tier")).toBe(true);
    expect(shouldRetainStarterNotice(notice, scope, undefined)).toBe(false);
  });

  it("keeps a failure notice, which describes a past event with no live source", () => {
    const notice = starterFailureNotice("start-failed", "offline", scope);
    expect(shouldRetainStarterNotice(notice, scope, undefined)).toBe(true);
  });

  it("drops any notice that no longer matches the selected machine and workspace", () => {
    expect(shouldRetainStarterNotice(starterPolicyBlockedNotice(scope), otherWorkspace, "reason")).toBe(false);
    expect(shouldRetainStarterNotice(starterFailureNotice("defaults-failed", "offline", scope), otherMachine, undefined)).toBe(false);
    expect(shouldRetainStarterNotice(starterFailureNotice("defaults-failed", "offline", scope), undefined, undefined)).toBe(false);
  });
});
