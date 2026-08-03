/**
 * A starter notice reports that a starter action failed or was refused while the
 * starter context itself stays valid and repairable.
 *
 * It is deliberately not part of `AppState`. `shouldShowSessionStartScreen()`
 * requires `state.error === ""`, so publishing a starter message there unmounts
 * the composer, the model-policy pill, and the tier menu — the controls that
 * repair the condition being reported.
 */
export type StarterNoticeKind = "policy-blocked" | "start-failed" | "defaults-failed";

/** The machine and workspace a notice belongs to. */
export interface StarterNoticeScope {
  machineId: string;
  workspaceId: string;
}

export interface StarterNotice {
  kind: StarterNoticeKind;
  /** Fixed text for failures; omitted when the reason is read live. */
  message?: string;
  scope: StarterNoticeScope;
}

/**
 * A refused start carries no captured text. Its message is read live from the
 * current `blockedReason` at render time, so repairing the ladder or choosing a
 * valid tier retires it on the next render with no stale string. A captured copy
 * would reintroduce exactly that staleness, which is why this factory exists
 * instead of a general constructor callers could hand a message to.
 */
export function starterPolicyBlockedNotice(scope: StarterNoticeScope): StarterNotice {
  return { kind: "policy-blocked", scope };
}

/**
 * A failed start or defaults load describes a past event with no live source to
 * re-read, so its text is captured once.
 */
export function starterFailureNotice(
  kind: "start-failed" | "defaults-failed",
  message: string,
  scope: StarterNoticeScope,
): StarterNotice {
  return { kind, message, scope };
}

/**
 * The text to render for `notice` right now, or undefined when it must not be
 * shown at all: a different machine or workspace is selected, a policy-blocked
 * notice has no live reason left, or the notice carries no usable text.
 */
export function starterNoticeVisibleText(
  notice: StarterNotice | undefined,
  currentScope: StarterNoticeScope | undefined,
  liveBlockedReason: string | undefined,
): string | undefined {
  if (notice === undefined || !inScope(notice, currentScope)) return undefined;
  const text = notice.kind === "policy-blocked" ? liveBlockedReason : notice.message;
  return text === undefined || text === "" ? undefined : text;
}

/**
 * Whether `notice` survives into the next render.
 *
 * A policy-blocked notice is dropped, not merely hidden, once its live reason is
 * gone: it then means strictly "the user's last Start attempt was refused" and
 * cannot reappear after an external repair without a fresh attempt.
 */
export function shouldRetainStarterNotice(
  notice: StarterNotice,
  currentScope: StarterNoticeScope | undefined,
  liveBlockedReason: string | undefined,
): boolean {
  if (!inScope(notice, currentScope)) return false;
  if (notice.kind !== "policy-blocked") return true;
  return liveBlockedReason !== undefined && liveBlockedReason !== "";
}

function inScope(notice: StarterNotice, currentScope: StarterNoticeScope | undefined): boolean {
  if (currentScope === undefined) return false;
  return notice.scope.machineId === currentScope.machineId
    && notice.scope.workspaceId === currentScope.workspaceId;
}
