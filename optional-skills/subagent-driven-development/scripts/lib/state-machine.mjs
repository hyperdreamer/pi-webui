/**
 * The deterministic SDD state machine.
 *
 * This module is the enforcement boundary the whole candidate skill exists for.
 * A controller can reason its way to the right phase name and still invert a
 * convention the skill defines: in the recorded baseline, both conditions on
 * `post-compaction-illegal-transition` produced the correct phase token and then
 * asserted the append-only audit ledger was authoritative and `state.json` a
 * derived cache. Both invented repair mechanisms. Prose telling a controller to
 * trust the ledger is advice; a reducer that refuses the transition is
 * enforcement.
 *
 * `state.json` is canonical. The ledger is an append-only audit trail derived
 * from it. That direction is not negotiable and is the rule this module exists
 * to make unstateable.
 *
 * The reducer is pure: no filesystem, Git, subprocess, network, randomness, or
 * clock. Every value that varies between runs arrives in the event, so a
 * transition is reproducible from `(state, event)` alone.
 */

import { createHash } from "node:crypto";

import { roleTier, TIERS } from "./plan-policy.mjs";

/** Current serialized state version. */
export const STATE_VERSION = 1;

/** Maximum bytes for any single human-supplied string recorded in state. */
const MAX_RECORD_CHARS = 256;

/** Maximum bytes for one rendered audit line. */
const MAX_AUDIT_LINE_BYTES = 8 * 1024;

/** Maximum bytes for the whole serialized state document. */
const MAX_STATE_BYTES = 1024 * 1024;

/**
 * Maximum bytes for a stored rendered prompt.
 *
 * Matches the rendered-prompt limit, because recovery reissues these exact bytes
 * and a stored prompt that could not be sent is not a reissuable record.
 */
const MAX_PROMPT_BYTES = 384 * 1024;

/** The bounded controller-owned dispatch-key grammar. */
const DISPATCH_KEY = /^[A-Za-z0-9._:-]{1,240}$/u;

/** Roles that may be dispatched, and whether the key carries a fix round. */
const ROLE_ROUNDS = Object.freeze({
  implementer: false,
  "task-reviewer": false,
  "re-reviewer": false,
  final: false,
  fixer: true,
});

/** The four implementer status tokens, inherited from the original skill. */
const IMPLEMENTER_STATUSES = Object.freeze([
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
]);

/**
 * Concern kinds that may pass straight to review.
 *
 * A concern about correctness or scope is a finding, not a note, so it requires
 * a recorded ruling before the work counts as reviewable.
 */
const OBSERVATIONAL_CONCERN = "observational";

/** Maximum context enrichments before a task blocks. */
const MAX_CONTEXT_ATTEMPTS = 2;

/**
 * The audit-line marker. Human text is rejected rather than escaped when it
 * contains this, so no recorded reason can forge a transition record.
 */
const AUDIT_MARKER = "<!-- sdd-transition:";

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SHA1_HEX = /^[0-9a-f]{40}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * Every legal phase.
 *
 * Task 5 populates the capability, plan, and task-dispatch phases. Task 6 adds
 * the review, fix, and final loops. The set is declared whole so an unknown
 * phase is rejected from the first commit rather than becoming legal by
 * omission.
 */
export const PHASES = Object.freeze([
  "CAPABILITY_CHECK",
  "CAPABILITY_BLOCKED",
  "PLAN_CHECK",
  "PLAN_INVALID",
  "PREFLIGHT_DECISION_REQUIRED",
  "WORKSPACE_READY",
  "IMPLEMENT_DISPATCH_INTENT",
  "IMPLEMENT_RUNNING",
  "IMPLEMENT_RESULT",
  "TASK_BLOCKED",
  "DISPATCH_MISMATCH_BLOCKED",
  "DISPATCH_AMBIGUOUS",
  "REVIEW_DISPATCH_INTENT",
  "REVIEW_RUNNING",
  "REVIEW_RESULT",
  "FIX_DISPATCH_INTENT",
  "FIX_RUNNING",
  "REREVIEW_DISPATCH_INTENT",
  "REREVIEW_RUNNING",
  "TASK_COMPLETE",
  "FINAL_REVIEW_DISPATCH_INTENT",
  "FINAL_REVIEW_RUNNING",
  "FINAL_FIX_DISPATCH_INTENT",
  "FINAL_FIX_RUNNING",
  "FINAL_REREVIEW_DISPATCH_INTENT",
  "FINAL_REREVIEW_RUNNING",
  "FINAL_BLOCKED",
  "COMPLETE",
]);

const PHASE_SET = new Set(PHASES);
const TIER_SET = new Set(TIERS);

/** A rejected transition or malformed state. */
export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = "StateError";
  }
}

const fail = (message) => {
  throw new StateError(message);
};

/**
 * Validate a bounded single-line human string.
 *
 * Control characters are rejected outright rather than escaped. Escaping would
 * let a caller smuggle marker-shaped text through and rely on a later consumer
 * unescaping it; rejecting keeps exactly one representation.
 */
const bounded = (value, field) => {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_RECORD_CHARS) {
    fail(`${field} exceeds ${String(MAX_RECORD_CHARS)} characters`);
  }
  // eslint-disable-next-line no-control-regex -- the point is to reject these.
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${field} must not contain a control character`);
  }
  if (value.includes(AUDIT_MARKER)) {
    fail(`${field} must not contain ${AUDIT_MARKER}`);
  }
  return value;
};

const instant = (value, field) => {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    fail(`${field} must be an ISO-8601 instant with millisecond precision`);
  }
  return value;
};

const absolutePath = (value, field) => {
  if (typeof value !== "string" || !value.startsWith("/")) {
    fail(`${field} must be an absolute path`);
  }
  if (value.includes("\u0000")) {
    fail(`${field} must not contain a NUL byte`);
  }
  if (value.split("/").includes("..")) {
    fail(`${field} must be normalized and contain no ".." segment`);
  }
  return value;
};

const nonNegativeInteger = (value, field) => {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer`);
  }
  return value;
};

/**
 * Derive the run identity.
 *
 * NUL-joined because no component may contain one, so the concatenation is
 * unambiguous. `createdAt` participates so two runs of the same plan on the same
 * commit are distinguishable.
 */
export const computeRunId = ({ planDigest, worktree, branch, mergeBase, createdAt }) =>
  createHash("sha256")
    .update([planDigest, worktree, branch, mergeBase, createdAt].join("\u0000"))
    .digest("hex");

const deepFreeze = (value) => {
  if (value === null || typeof value !== "object") return value;
  for (const inner of Object.values(value)) deepFreeze(inner);
  return Object.freeze(value);
};

/**
 * Compose a controller-owned dispatch key.
 *
 * This key never reaches `spawn_subsession`, which accepts only
 * `{ prompt, cwd, tier }`. It names a row in the run's own dispatch ledger so
 * recovery can correlate a recorded intent to the `sessionId` the tool returned.
 * The runtime performs no deduplication, so this key buys correlation, never
 * idempotency.
 */
export function dispatchKeyFor({ runId, task, role, attempt, round }) {
  if (typeof runId !== "string" || !SHA256_HEX.test(runId)) {
    fail("dispatchKeyFor requires the run's SHA-256 runId");
  }
  const needsRound = ROLE_ROUNDS[role];
  if (needsRound === undefined) {
    fail(`dispatchKeyFor received unknown role ${String(role)}`);
  }
  if (!Number.isInteger(task) || task < 1) fail("dispatchKeyFor requires a positive task number");
  if (!Number.isInteger(attempt) || attempt < 1) {
    fail("dispatchKeyFor requires a positive attempt number");
  }
  if (needsRound && !Number.isInteger(round)) {
    fail(`role ${role} requires a fix round in its dispatch key`);
  }
  if (!needsRound && round !== undefined) {
    fail(`role ${role} does not accept a fix round in its dispatch key`);
  }

  const parts = [runId, `task-${String(task)}`, role, `attempt-${String(attempt)}`];
  if (needsRound) parts.push(`round-${String(round)}`);
  const key = parts.join(":");
  if (!DISPATCH_KEY.test(key)) fail(`composed dispatchKey violates its grammar: ${key}`);
  return key;
}

/** Validate an artifact path is absolute, normalized, and inside the run root. */
const runArtifact = (value, field, runRoot) => {
  absolutePath(value, field);
  if (!value.startsWith(`${runRoot}/`)) {
    fail(`${field} must be beneath the pinned run root ${runRoot}`);
  }
  return value;
};

/**
 * Build the dispatch record for a validated intent.
 *
 * The record is complete before a session exists, so a crash between the spawn
 * call and the correlation write leaves bytes that can be reissued verbatim.
 */
const buildIntent = (state, event) => {
  const role = event.role;
  const needsRound = ROLE_ROUNDS[role];
  if (needsRound === undefined) fail(`dispatch-intended received unknown role ${String(role)}`);

  if (!Number.isInteger(event.attempt) || event.attempt < 1) {
    fail("dispatch-intended requires a positive attempt");
  }

  // The tier is the binding channel, so it must equal what the role formula
  // says. A controller that wants a different tier must change the plan.
  const expected = roleTier({
    implementer: state.currentImplementerTier,
    role,
    ...(needsRound ? { round: state.fixRound } : {}),
  }).tier;
  if (!TIER_SET.has(event.tier)) {
    fail(`dispatch-intended requires a known lowercase tier, got ${String(event.tier)}`);
  }
  if (event.tier !== expected) {
    fail(
      `dispatch-intended tier ${event.tier} differs from the role formula, which yields ${expected}`,
    );
  }

  if (typeof event.dispatchKey !== "string" || !DISPATCH_KEY.test(event.dispatchKey)) {
    fail("dispatch-intended requires a dispatchKey matching ^[A-Za-z0-9._:-]{1,240}$");
  }
  const wanted = dispatchKeyFor({
    runId: state.runId,
    task: state.currentTask,
    role,
    attempt: event.attempt,
    ...(needsRound ? { round: state.fixRound } : {}),
  });
  if (event.dispatchKey !== wanted) {
    fail("dispatch-intended dispatchKey does not match this run, task, role, and attempt");
  }

  if (typeof event.renderedPrompt !== "string" || event.renderedPrompt.length === 0) {
    fail(
      "dispatch-intended requires the exact renderedPrompt bytes; an intent that cannot be reissued verbatim is not a valid intent",
    );
  }
  if (Buffer.byteLength(event.renderedPrompt, "utf8") > MAX_PROMPT_BYTES) {
    fail(`renderedPrompt exceeds ${String(MAX_PROMPT_BYTES)} bytes (384 KiB)`);
  }

  // A leading `/tier-*` line is a human-readable echo with no control effect.
  // Its absence is fine; a disagreement with the typed tier means the renderer
  // and the formula have diverged and must not be papered over.
  const echo = /^\/tier-([a-z]+)[ \t]*(?:\r?\n|$)/u.exec(event.renderedPrompt);
  if (echo !== null && echo[1] !== event.tier) {
    fail(
      `renderer/formula divergence: prompt echoes /tier-${echo[1]} while the typed tier is ${event.tier}`,
    );
  }

  bounded(event.expectedOutcome, "expectedOutcome");

  return {
    dispatchKey: event.dispatchKey,
    role,
    tier: event.tier,
    attempt: event.attempt,
    round: needsRound ? state.fixRound : null,
    promptPath: runArtifact(event.promptPath, "promptPath", state.runRoot),
    reportPath: runArtifact(event.reportPath, "reportPath", state.runRoot),
    briefPath: runArtifact(event.briefPath, "briefPath", state.runRoot),
    expectedOutcome: event.expectedOutcome,
    renderedPrompt: event.renderedPrompt,
    sessionId: null,
    reissued: false,
    status: null,
    concerns: [],
  };
};

/** Validate and normalize reported implementer concerns. */
const normalizeConcerns = (concerns) => {
  if (concerns === undefined) return [];
  if (!Array.isArray(concerns)) fail("concerns must be an array when present");
  return concerns.map((concern, index) => {
    if (concern === null || typeof concern !== "object") {
      fail(`concerns[${String(index)}] must be an object`);
    }
    bounded(concern.kind, `concerns[${String(index)}].kind`);
    bounded(concern.note, `concerns[${String(index)}].note`);
    return { kind: concern.kind, note: concern.note };
  });
};

/** A session id recorded against a dispatch. */
const sessionId = (value) => {
  bounded(value, "sessionId");
  return value;
};

/** Validate the immutable task index and detach it from caller-owned input. */
const normalizeTasks = (tasks) => {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    fail("tasks must be a non-empty array");
  }
  return tasks.map((task, index) => {
    if (task === null || typeof task !== "object") {
      fail(`tasks[${String(index)}] must be an object`);
    }
    if (task.number !== index + 1) {
      fail(
        `tasks must be contiguous from 1: tasks[${String(index)}] has number ${String(task.number)}`,
      );
    }
    if (!TIER_SET.has(task.implementerTier)) {
      fail(
        `tasks[${String(index)}].implementerTier must be one of ${TIERS.join(", ")}, got ${String(task.implementerTier)}`,
      );
    }
    return { number: task.number, implementerTier: task.implementerTier };
  });
};

/**
 * Build the initial state.
 *
 * Every version-1 field is constructed explicitly. Nothing is left undefined to
 * be filled in by a later transition, so `validateState` can demand the whole
 * shape from revision 0 onward.
 */
export function createInitialState({
  planPath,
  planDigest,
  repoRoot,
  worktree,
  runRoot,
  branch,
  baseRef,
  mergeBase,
  tasks,
  at,
}) {
  absolutePath(planPath, "planPath");
  absolutePath(repoRoot, "repoRoot");
  absolutePath(worktree, "worktree");
  absolutePath(runRoot, "runRoot");
  if (typeof planDigest !== "string" || !SHA256_HEX.test(planDigest)) {
    fail("planDigest must be a lowercase 64-character SHA-256 hex digest");
  }
  if (typeof mergeBase !== "string" || !SHA1_HEX.test(mergeBase)) {
    fail("mergeBase must be a lowercase 40-character hex object name");
  }
  bounded(branch, "branch");
  bounded(baseRef, "baseRef");
  const createdAt = instant(at, "at");

  // The run root must live inside the pinned worktree, so no artifact path
  // validated against it can escape the tree the run owns.
  if (!runRoot.startsWith(`${worktree}/`)) {
    fail("runRoot must be beneath worktree");
  }

  const taskIndex = normalizeTasks(tasks);

  return deepFreeze({
    version: STATE_VERSION,
    revision: 0,
    runId: computeRunId({ planDigest, worktree, branch, mergeBase, createdAt }),
    phase: "CAPABILITY_CHECK",
    planPath,
    planDigest,
    repoRoot,
    worktree,
    runRoot,
    branch,
    baseRef,
    mergeBase,
    createdAt,
    tasks: taskIndex,
    currentTask: 1,
    currentImplementerTier: taskIndex[0].implementerTier,
    contextAttempts: 0,
    fixRound: 0,
    finalFixUsed: false,
    mode: null,
    dispatch: null,
    lastTransition: `${AUDIT_MARKER} revision=0 phase=CAPABILITY_CHECK event=run-initialized at=${createdAt} -->`,
    updatedAt: createdAt,
  });
}

/**
 * Assert a state document is well-formed.
 *
 * Called on the result of every transition, so a handler cannot produce a state
 * that later loads as invalid.
 */
export function validateState(state) {
  if (state === null || typeof state !== "object") {
    fail("state must be an object");
  }
  if (state.version !== STATE_VERSION) {
    fail(`unsupported state version ${String(state.version)}`);
  }
  if (!PHASE_SET.has(state.phase)) {
    fail(`unknown phase ${String(state.phase)}`);
  }
  nonNegativeInteger(state.revision, "revision");
  nonNegativeInteger(state.contextAttempts, "contextAttempts");
  nonNegativeInteger(state.fixRound, "fixRound");
  if (typeof state.finalFixUsed !== "boolean") {
    fail("finalFixUsed must be a boolean");
  }
  const tasks = normalizeTasks(state.tasks);
  if (!Number.isInteger(state.currentTask) || state.currentTask < 1 || state.currentTask > tasks.length) {
    fail(`currentTask must name a task in the index, got ${String(state.currentTask)}`);
  }
  if (!TIER_SET.has(state.currentImplementerTier)) {
    fail(`currentImplementerTier must be a known tier, got ${String(state.currentImplementerTier)}`);
  }
  if (state.mode !== null && state.mode !== "exact" && state.mode !== "tiered") {
    fail(`mode must be null, "exact", or "tiered", got ${String(state.mode)}`);
  }
  instant(state.updatedAt, "updatedAt");
  if (typeof state.lastTransition !== "string") {
    fail("lastTransition must be a string");
  }
  if (Buffer.byteLength(state.lastTransition, "utf8") > MAX_AUDIT_LINE_BYTES) {
    fail(`lastTransition exceeds ${String(MAX_AUDIT_LINE_BYTES)} bytes (8 KiB)`);
  }
  if (/[\r\n]/u.test(state.lastTransition)) {
    fail("lastTransition must be exactly one line");
  }
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) {
    fail(`serialized state exceeds ${String(MAX_STATE_BYTES)} bytes (1 MiB)`);
  }
  return state;
}

/** Render the one-line audit record for a completed transition. */
const renderTransition = (state, eventType) =>
  `${AUDIT_MARKER} revision=${String(state.revision)} phase=${state.phase} event=${eventType} at=${state.updatedAt} -->`;

/**
 * Phase/event handlers.
 *
 * Exactly one handler is looked up per `(phase, event.type)` pair. A missing
 * entry is an illegal transition, so the legal set is whatever appears here and
 * nothing else. Each handler returns only the fields it changes.
 */
const HANDLERS = Object.freeze({
  CAPABILITY_CHECK: {
    "capability-confirmed": (state, event) => {
      if (event.mode !== "exact" && event.mode !== "tiered") {
        fail(`capability-confirmed requires mode "exact" or "tiered", got ${String(event.mode)}`);
      }
      return { phase: "PLAN_CHECK", mode: event.mode };
    },
    "capability-missing": (state, event) => ({
      phase: "CAPABILITY_BLOCKED",
      blockedReason: bounded(event.reason, "reason"),
    }),
  },
  PLAN_CHECK: {
    "plan-valid": (state, event) => {
      if (event.planDigest !== state.planDigest) {
        fail("plan-valid digest does not match the pinned plan digest");
      }
      return { phase: "WORKSPACE_READY" };
    },
    "plan-invalid": (state, event) => ({
      phase: "PLAN_INVALID",
      blockedReason: bounded(event.reason, "reason"),
    }),
    "plan-conflict": (state, event) => {
      if (typeof event.planDigest !== "string" || !SHA256_HEX.test(event.planDigest)) {
        fail("plan-conflict requires the observed planDigest");
      }
      if (event.planDigest === state.planDigest) {
        fail("plan-conflict requires a digest differing from the pinned plan digest");
      }
      return {
        phase: "PLAN_INVALID",
        blockedReason: `plan digest changed under the run: observed ${event.planDigest.slice(0, 12)}`,
      };
    },
    "preflight-decision-required": (state, event) => ({
      phase: "PREFLIGHT_DECISION_REQUIRED",
      blockedReason: bounded(event.reason, "reason"),
    }),
  },
  WORKSPACE_READY: {
    "preflight-decision-required": (state, event) => ({
      phase: "PREFLIGHT_DECISION_REQUIRED",
      blockedReason: bounded(event.reason, "reason"),
    }),
    "dispatch-intended": (state, event) => ({
      phase: "IMPLEMENT_DISPATCH_INTENT",
      dispatch: buildIntent(state, event),
    }),
  },
  IMPLEMENT_DISPATCH_INTENT: {
    // Correlation only. The tool already ran; this records which child it made.
    "dispatch-started": (state, event) => ({
      phase: "IMPLEMENT_RUNNING",
      dispatch: { ...state.dispatch, sessionId: sessionId(event.sessionId) },
    }),
    // The window between the spawn call and this write cannot be closed from
    // here. It can only be made visible.
    "dispatch-window-crossed": (state, event) => ({
      phase: "DISPATCH_AMBIGUOUS",
      blockedReason: bounded(event.reason, "reason"),
    }),
  },
  DISPATCH_AMBIGUOUS: {
    // The reducer never picks. Adoption names an observed child; reissue accepts
    // a possible orphan. Both are recorded decisions, not inferences.
    "dispatch-ruling-recorded": (state, event) => {
      bounded(event.reason, "reason");
      if (event.decision === "adopt") {
        if (event.sessionId === undefined) {
          fail("a dispatch ruling that adopts a child requires its sessionId");
        }
        return {
          phase: "IMPLEMENT_RUNNING",
          blockedReason: null,
          dispatch: { ...state.dispatch, sessionId: sessionId(event.sessionId) },
        };
      }
      if (event.decision === "reissue") {
        if (event.sessionId !== undefined) {
          fail("a dispatch ruling that reissues must not name a sessionId");
        }
        return {
          phase: "IMPLEMENT_DISPATCH_INTENT",
          blockedReason: null,
          dispatch: { ...state.dispatch, sessionId: null, reissued: true },
        };
      }
      return fail(
        `dispatch-ruling-recorded requires decision "adopt" or "reissue", got ${String(event.decision)}`,
      );
    },
  },
  IMPLEMENT_RUNNING: {
    // Classification is a separate transition, so a status token is recorded
    // before anything is decided from it.
    "child-completed": (state, event) => {
      if (!IMPLEMENTER_STATUSES.includes(event.status)) {
        fail(
          `child-completed requires a known status, one of ${IMPLEMENTER_STATUSES.join(", ")}, got ${String(event.status)}`,
        );
      }
      runArtifact(event.reportPath, "reportPath", state.runRoot);
      return {
        phase: "IMPLEMENT_RESULT",
        dispatch: {
          ...state.dispatch,
          status: event.status,
          reportPath: event.reportPath,
          concerns: normalizeConcerns(event.concerns),
        },
      };
    },
  },
  IMPLEMENT_RESULT: {
    "review-required": (state) => {
      if (state.dispatch.status !== "DONE" && state.dispatch.status !== "DONE_WITH_CONCERNS") {
        fail(`review-required is not legal for status ${String(state.dispatch.status)}`);
      }
      const blocking = state.dispatch.concerns.filter(
        (concern) => concern.kind !== OBSERVATIONAL_CONCERN,
      );
      if (blocking.length > 0) {
        fail(
          `a ${blocking[0].kind} concern requires a recorded ruling before review; only observational concerns pass through`,
        );
      }
      return { phase: "REVIEW_DISPATCH_INTENT" };
    },
    // Enrichment retries the same task at the planned tier. It is not a fix
    // round, so fixRound is untouched.
    "context-enrichment-required": (state, event) => {
      if (state.dispatch.status !== "NEEDS_CONTEXT") {
        fail("context-enrichment-required is only legal after NEEDS_CONTEXT");
      }
      bounded(event.reason, "reason");
      if (state.contextAttempts >= MAX_CONTEXT_ATTEMPTS) {
        fail(
          `context enrichment is bounded at ${String(MAX_CONTEXT_ATTEMPTS)} attempts; the task must block instead`,
        );
      }
      return {
        phase: "IMPLEMENT_DISPATCH_INTENT",
        contextAttempts: state.contextAttempts + 1,
        dispatch: { ...state.dispatch, sessionId: null, status: null, concerns: [] },
      };
    },
    "task-blocked": (state, event) => ({
      phase: "TASK_BLOCKED",
      blockedReason: bounded(event.reason, "reason"),
    }),
  },
  PREFLIGHT_DECISION_REQUIRED: {
    // A ruling must be persisted before work resumes. The reducer never infers
    // one from the absence of an objection.
    "preflight-ruling-recorded": (state, event) => {
      if (event.decision !== "proceed" && event.decision !== "abort") {
        fail(`preflight-ruling-recorded requires decision "proceed" or "abort", got ${String(event.decision)}`);
      }
      bounded(event.reason, "reason");
      return event.decision === "proceed"
        ? { phase: "WORKSPACE_READY", blockedReason: null }
        : { phase: "FINAL_BLOCKED", blockedReason: `preflight aborted: ${event.reason}` };
    },
  },
});

/**
 * Apply one typed event to a state document.
 *
 * The input is never mutated: the result is built from a structural clone, so a
 * caller holding the previous state keeps a stable value.
 */
export function reduceState(state, event) {
  validateState(state);
  if (event === null || typeof event !== "object") {
    fail("event must be an object");
  }
  if (typeof event.type !== "string" || event.type.length === 0) {
    fail("event.type must be a non-empty string");
  }

  const byPhase = HANDLERS[state.phase];
  const handler = byPhase?.[event.type];
  if (!handler) {
    const known = new Set(Object.values(HANDLERS).flatMap((entry) => Object.keys(entry)));
    if (!known.has(event.type)) {
      fail(`unknown event type ${event.type}`);
    }
    fail(`illegal transition: ${event.type} is not legal in phase ${state.phase}`);
  }

  const at = instant(event.at, "at");
  if (at < state.updatedAt) {
    fail(`event timestamp ${at} precedes the last transition at ${state.updatedAt}`);
  }

  const previous = structuredClone(state);
  const changes = handler(previous, event);

  const next = {
    ...previous,
    ...changes,
    revision: previous.revision + 1,
    updatedAt: at,
  };
  next.lastTransition = renderTransition(next, event.type);

  return deepFreeze(validateState(next));
}
