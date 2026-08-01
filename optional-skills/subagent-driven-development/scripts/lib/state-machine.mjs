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
 * Two structural rules follow from the baseline evidence and shape every handler
 * below:
 *
 * 1. **Recording a result and deciding what it means are separate transitions.**
 *    A `*-finished` event only pins a bounded artifact. An explicit controller
 *    event then selects the guarded next phase. A child's report can never
 *    choose the phase it leads to.
 * 2. **Nothing is inferred from absence.** Every branch that a human would call
 *    a judgement call requires a persisted ruling naming a decision and a
 *    reason. The reducer never picks the agreeable option by default.
 *
 * The reducer is pure: no filesystem, Git, subprocess, network, randomness, or
 * clock. Every value that varies between runs arrives in the event, so a
 * transition is reproducible from `(state, event)` alone.
 */

import { createHash } from "node:crypto";

import { roleTier, TIERS } from "./plan-policy.mjs";

/** Current serialized state version. */
export const STATE_VERSION = 1;

/** Maximum characters for any single human-supplied string recorded in state. */
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

/** Maximum findings tracked in one run's ledger. */
const MAX_FINDINGS = 512;

/** Maximum fix rounds per task. */
const MAX_FIX_ROUNDS = 5;

/** Maximum context enrichments before a task blocks. */
const MAX_CONTEXT_ATTEMPTS = 2;

/**
 * The audit-line marker. Human text is rejected rather than escaped when it
 * contains this, so no recorded reason can forge a transition record.
 */
const AUDIT_MARKER = "<!-- sdd-transition:";

/** The bounded controller-owned dispatch-key grammar. */
const DISPATCH_KEY = /^[A-Za-z0-9._:-]{1,240}$/u;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SHA1_HEX = /^[0-9a-f]{40}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FINDING_ID = /^[A-Za-z0-9._:-]{1,64}$/u;

/**
 * Every legal phase, matching `references/state-machine.md`.
 *
 * The set is frozen and complete, so an unknown phase is rejected rather than
 * becoming legal by omission.
 */
export const PHASES = Object.freeze([
  "CAPABILITY_CHECK",
  "CAPABILITY_BLOCKED",
  "PLAN_VALIDATE",
  "PLAN_INVALID",
  "PREFLIGHT_DECISION_REQUIRED",
  "WORKSPACE_READY",
  "IMPLEMENT_DISPATCH_INTENT",
  "IMPLEMENT_RUNNING",
  "IMPLEMENT_RESULT",
  "CONTEXT_REQUIRED",
  "CONCERN_DECISION_REQUIRED",
  "TASK_BLOCKED",
  "TASK_REVIEW_DISPATCH_INTENT",
  "TASK_REVIEW_RUNNING",
  "TASK_REVIEW_DECISION",
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
  "DISPATCH_MISMATCH_BLOCKED",
  "DISPATCH_AMBIGUOUS",
  "FINAL_BLOCKED",
  "COMPLETE",
]);

/** Phases that accept no ordinary continuation event. */
export const TERMINAL_PHASES = Object.freeze([
  "CAPABILITY_BLOCKED",
  "PLAN_INVALID",
  "TASK_BLOCKED",
  "DISPATCH_MISMATCH_BLOCKED",
  "FINAL_BLOCKED",
  "COMPLETE",
]);

/**
 * Dispatch-intent phases, their running counterpart, and the role dispatched.
 *
 * `tier` is `null` where the role formula decides, and a fixed tier where the
 * contract pins it regardless of the task's implementer tier.
 */
const INTENT_PHASES = Object.freeze({
  IMPLEMENT_DISPATCH_INTENT: { running: "IMPLEMENT_RUNNING", role: "implementer", tier: null },
  TASK_REVIEW_DISPATCH_INTENT: { running: "TASK_REVIEW_RUNNING", role: "task-reviewer", tier: null },
  FIX_DISPATCH_INTENT: { running: "FIX_RUNNING", role: "fixer", tier: null },
  REREVIEW_DISPATCH_INTENT: { running: "REREVIEW_RUNNING", role: "re-reviewer", tier: null },
  FINAL_REVIEW_DISPATCH_INTENT: {
    running: "FINAL_REVIEW_RUNNING",
    role: "final",
    tier: "frontier",
  },
  FINAL_FIX_DISPATCH_INTENT: {
    running: "FINAL_FIX_RUNNING",
    role: "final-fixer",
    tier: "frontier",
  },
  FINAL_REREVIEW_DISPATCH_INTENT: {
    running: "FINAL_REREVIEW_RUNNING",
    role: "final-re-reviewer",
    tier: "frontier",
  },
});

/** Roles that may be dispatched, and whether the key carries a fix round. */
const ROLE_ROUNDS = Object.freeze({
  implementer: false,
  "task-reviewer": false,
  "re-reviewer": false,
  final: false,
  fixer: true,
  "final-fixer": false,
  "final-re-reviewer": false,
});

/** The four implementer status tokens, inherited from the original skill. */
const IMPLEMENTER_STATUSES = Object.freeze([
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
]);

/** Concern kinds that pass to review without a ruling. */
const OBSERVATIONAL_CONCERN = "observational";

/**
 * Finding severities.
 *
 * `Critical` and `Important` are load-bearing: they open a fix round and can
 * never be parked. `Minor` is contestable and may be parked with a ruling.
 */
const LOAD_BEARING_SEVERITIES = Object.freeze(["Critical", "Important"]);
const SEVERITIES = Object.freeze([...LOAD_BEARING_SEVERITIES, "Minor"]);

/** Terminal dispositions a finding may reach. */
const RESOLVED_DISPOSITIONS = Object.freeze(["fixed", "parked", "out-of-scope", "cannot-verify"]);

const PHASE_SET = new Set(PHASES);
const TERMINAL_SET = new Set(TERMINAL_PHASES);
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
  if (value.includes("\u0000")) fail(`${field} must not contain a NUL byte`);
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

const enumerated = (value, allowed, field) => {
  if (!allowed.includes(value)) {
    fail(`${field} must be one of ${allowed.join(", ")}, got ${String(value)}`);
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
  if (needsRound === undefined) fail(`dispatchKeyFor received unknown role ${String(role)}`);
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
 * Validate one reported finding.
 *
 * Severity and load-bearing status are recorded at report time and never
 * recomputed later, so a finding cannot be downgraded on its way to being
 * dismissed.
 */
const normalizeFinding = (finding, index) => {
  if (finding === null || typeof finding !== "object") {
    fail(`findings[${String(index)}] must be an object`);
  }
  const id = finding.id;
  if (typeof id !== "string" || !FINDING_ID.test(id)) {
    fail(`findings[${String(index)}].id must match ^[A-Za-z0-9._:-]{1,64}$`);
  }
  enumerated(finding.severity, SEVERITIES, `findings[${String(index)}].severity`);
  bounded(finding.summary, `findings[${String(index)}].summary`);
  return {
    id,
    severity: finding.severity,
    summary: finding.summary,
    loadBearing: LOAD_BEARING_SEVERITIES.includes(finding.severity),
    disposition: "open",
    evidence: null,
  };
};

/**
 * Merge newly reported findings into the run ledger.
 *
 * Reporting is additive: an ID already present keeps its existing disposition
 * rather than being reset to open by a later review that mentions it again.
 */
const mergeFindings = (existing, reported, field) => {
  if (reported === undefined) return existing;
  if (!Array.isArray(reported)) fail(`${field} must be an array when present`);

  const merged = existing.map((finding) => ({ ...finding }));
  const byId = new Map(merged.map((finding) => [finding.id, finding]));

  for (const [index, raw] of reported.entries()) {
    const finding = normalizeFinding(raw, index);
    const prior = byId.get(finding.id);
    if (prior === undefined) {
      merged.push(finding);
      byId.set(finding.id, finding);
      continue;
    }
    if (prior.severity !== finding.severity) {
      fail(
        `finding ${finding.id} was already recorded as ${prior.severity} and cannot be re-reported as ${finding.severity}`,
      );
    }
  }

  if (merged.length > MAX_FINDINGS) {
    fail(`the finding ledger is bounded at ${String(MAX_FINDINGS)} entries`);
  }
  return merged;
};

/**
 * Apply controller adjudication to the ledger as a set operation.
 *
 * This is the retention guarantee. Every ID present before must still be present
 * after, so no event can silently drop an open, deferred, or parked finding. A
 * disposition may only be set with evidence, and a load-bearing finding can
 * never be parked.
 */
const applyResolutions = (existing, resolutions, field) => {
  if (resolutions === undefined) return existing;
  if (!Array.isArray(resolutions)) fail(`${field} must be an array when present`);

  const byId = new Map(existing.map((finding) => [finding.id, { ...finding }]));

  for (const [index, entry] of resolutions.entries()) {
    if (entry === null || typeof entry !== "object") {
      fail(`${field}[${String(index)}] must be an object`);
    }
    const target = byId.get(entry.id);
    if (target === undefined) {
      fail(`${field}[${String(index)}] names unknown finding ${String(entry.id)}`);
    }
    enumerated(entry.disposition, RESOLVED_DISPOSITIONS, `${field}[${String(index)}].disposition`);
    bounded(entry.evidence, `${field}[${String(index)}].evidence`);

    if (entry.disposition === "parked" && target.loadBearing) {
      fail(
        `finding ${target.id} is ${target.severity} and load-bearing, so it cannot be parked; it must be fixed or the run blocks`,
      );
    }
    if (target.disposition !== "open" && target.disposition !== entry.disposition) {
      fail(
        `finding ${target.id} is already ${target.disposition} and cannot be changed to ${entry.disposition}`,
      );
    }
    byId.set(entry.id, {
      ...target,
      disposition: entry.disposition,
      evidence: entry.evidence,
    });
  }

  // Retention check: the ledger may grow through reporting, never shrink here.
  const after = [...byId.values()];
  if (after.length !== existing.length) {
    fail("adjudication must not add or remove findings; report them instead");
  }
  return after;
};

/** Findings still demanding work. */
const openFindings = (findings) => findings.filter((finding) => finding.disposition === "open");

/** Open findings that cannot be parked or deferred. */
const openLoadBearing = (findings) => openFindings(findings).filter((finding) => finding.loadBearing);

/**
 * Build the dispatch record for a validated intent.
 *
 * The record is complete before a session exists, so a crash between the spawn
 * call and the correlation write leaves bytes that can be reissued verbatim.
 */
const buildIntent = (state, event, intentPhase) => {
  const definition = INTENT_PHASES[intentPhase];
  const role = definition.role;
  const needsRound = ROLE_ROUNDS[role];

  if (!Number.isInteger(event.attempt) || event.attempt < 1) {
    fail("a dispatch intent requires a positive attempt");
  }

  // The tier is the binding channel, so it must equal what the contract says.
  // A controller wanting a different tier must change the plan.
  const expected =
    definition.tier ??
    roleTier({
      implementer: state.currentImplementerTier,
      role,
      ...(needsRound ? { round: state.fixRound } : {}),
    }).tier;

  if (!TIER_SET.has(event.tier)) {
    fail(`a dispatch intent requires a known lowercase tier, got ${String(event.tier)}`);
  }
  if (event.tier !== expected) {
    fail(
      `dispatch tier ${event.tier} differs from the role formula for ${role}, which yields ${expected}`,
    );
  }

  if (typeof event.dispatchKey !== "string" || !DISPATCH_KEY.test(event.dispatchKey)) {
    fail("a dispatch intent requires a dispatchKey matching ^[A-Za-z0-9._:-]{1,240}$");
  }
  const wanted = dispatchKeyFor({
    runId: state.runId,
    task: state.currentTask,
    role,
    attempt: event.attempt,
    ...(needsRound ? { round: state.fixRound } : {}),
  });
  if (event.dispatchKey !== wanted) {
    fail("dispatchKey does not match this run, task, role, and attempt");
  }

  if (typeof event.renderedPrompt !== "string" || event.renderedPrompt.length === 0) {
    fail(
      "a dispatch intent requires the exact renderedPrompt bytes; an intent that cannot be reissued verbatim is not a valid intent",
    );
  }
  if (Buffer.byteLength(event.renderedPrompt, "utf8") > MAX_PROMPT_BYTES) {
    fail(`renderedPrompt exceeds ${String(MAX_PROMPT_BYTES)} bytes (384 KiB)`);
  }

  // A leading `/tier-*` line is a human-readable echo with no control effect.
  // Its absence is fine; a disagreement with the typed tier means the renderer
  // and the contract have diverged and must not be papered over.
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
const sessionIdOf = (value) => {
  bounded(value, "sessionId");
  return value;
};

/** Record a bounded child artifact without letting it choose a phase. */
const pinResult = (state, event, extra = {}) => ({
  ...state.dispatch,
  reportPath: runArtifact(event.reportPath, "reportPath", state.runRoot),
  ...extra,
});

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
  if (!runRoot.startsWith(`${worktree}/`)) fail("runRoot must be beneath worktree");

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
    findings: [],
    reviewOutcome: null,
    blockedReason: null,
    recoveryRulings: 0,
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
  if (state === null || typeof state !== "object") fail("state must be an object");
  if (state.version !== STATE_VERSION) {
    fail(`unsupported state version ${String(state.version)}`);
  }
  if (!PHASE_SET.has(state.phase)) fail(`unknown phase ${String(state.phase)}`);
  nonNegativeInteger(state.revision, "revision");
  nonNegativeInteger(state.contextAttempts, "contextAttempts");
  nonNegativeInteger(state.fixRound, "fixRound");
  nonNegativeInteger(state.recoveryRulings, "recoveryRulings");
  if (state.fixRound > MAX_FIX_ROUNDS) {
    fail(`fixRound is capped at ${String(MAX_FIX_ROUNDS)}, got ${String(state.fixRound)}`);
  }
  if (state.contextAttempts > MAX_CONTEXT_ATTEMPTS) {
    fail(`contextAttempts is capped at ${String(MAX_CONTEXT_ATTEMPTS)}`);
  }
  if (typeof state.finalFixUsed !== "boolean") fail("finalFixUsed must be a boolean");

  const tasks = normalizeTasks(state.tasks);
  if (
    !Number.isInteger(state.currentTask) ||
    state.currentTask < 1 ||
    state.currentTask > tasks.length
  ) {
    fail(`currentTask must name a task in the index, got ${String(state.currentTask)}`);
  }
  if (!TIER_SET.has(state.currentImplementerTier)) {
    fail(`currentImplementerTier must be a known tier, got ${String(state.currentImplementerTier)}`);
  }
  if (state.mode !== null && state.mode !== "exact" && state.mode !== "tiered") {
    fail(`mode must be null, "exact", or "tiered", got ${String(state.mode)}`);
  }
  if (!Array.isArray(state.findings)) fail("findings must be an array");
  if (state.findings.length > MAX_FINDINGS) {
    fail(`the finding ledger is bounded at ${String(MAX_FINDINGS)} entries`);
  }
  for (const [index, finding] of state.findings.entries()) {
    if (!FINDING_ID.test(String(finding?.id))) {
      fail(`findings[${String(index)}].id is malformed`);
    }
    enumerated(finding.severity, SEVERITIES, `findings[${String(index)}].severity`);
    enumerated(
      finding.disposition,
      ["open", ...RESOLVED_DISPOSITIONS],
      `findings[${String(index)}].disposition`,
    );
    if (finding.disposition === "parked" && finding.loadBearing) {
      fail(`findings[${String(index)}] is load-bearing and cannot be parked`);
    }
  }

  instant(state.updatedAt, "updatedAt");
  if (typeof state.lastTransition !== "string") fail("lastTransition must be a string");
  if (Buffer.byteLength(state.lastTransition, "utf8") > MAX_AUDIT_LINE_BYTES) {
    fail(`lastTransition exceeds ${String(MAX_AUDIT_LINE_BYTES)} bytes (8 KiB)`);
  }
  if (/[\r\n]/u.test(state.lastTransition)) fail("lastTransition must be exactly one line");
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) {
    fail(`serialized state exceeds ${String(MAX_STATE_BYTES)} bytes (1 MiB)`);
  }
  return state;
}

/** Record a review verdict: both axes must be explicit. */
const reviewOutcomeOf = (event) => ({
  specStatus: enumerated(event.specStatus, ["PASS", "FAIL"], "specStatus"),
  qualityStatus: enumerated(
    event.qualityStatus,
    ["APPROVED", "CHANGES_REQUESTED"],
    "qualityStatus",
  ),
  pinned: false,
});

/** A result-pinned phase requires its result recorded first. */
const requirePinned = (state) => {
  if (state.reviewOutcome?.pinned !== true) {
    fail("this adjudication requires a recorded review result first");
  }
};

/**
 * Complete a task.
 *
 * Both axes must pass and no load-bearing finding may remain open. This is the
 * gate the baseline controls talked their way past.
 */
const approveTask = (state, event) => {
  const outcome = state.reviewOutcome;
  if (outcome === null) fail("task approval requires a recorded review result");
  if (outcome.specStatus !== "PASS") {
    fail(`task approval requires spec PASS, got ${outcome.specStatus}`);
  }
  if (outcome.qualityStatus !== "APPROVED") {
    fail(`task approval requires quality APPROVED, got ${outcome.qualityStatus}`);
  }
  const findings = applyResolutions(state.findings, event.findingResolutions, "findingResolutions");
  const residual = openLoadBearing(findings);
  if (residual.length > 0) {
    fail(
      `task approval is blocked by ${String(residual.length)} open load-bearing finding(s), starting with ${residual[0].id}`,
    );
  }
  return { phase: "TASK_COMPLETE", findings, statusPinned: false };
};

/** Open the next fix round, enforcing the 1..5 cap. */
const openFixRound = (state, event) => {
  const round = state.fixRound + 1;
  if (round > MAX_FIX_ROUNDS) {
    fail(
      `fix rounds are capped at ${String(MAX_FIX_ROUNDS)}; a load-bearing residual at round ${String(state.fixRound)} must block`,
    );
  }
  const outcome = state.reviewOutcome;
  if (outcome === null) fail("a fix round requires a recorded review result");
  const needsWork =
    outcome.specStatus === "FAIL" ||
    outcome.qualityStatus === "CHANGES_REQUESTED" ||
    openFindings(state.findings).length > 0;
  if (!needsWork) {
    fail("a fix round requires a spec failure, requested changes, or an open finding");
  }

  // The tier escalates with the round, so fixRound must advance before the
  // intent is validated against the formula.
  const advanced = { ...state, fixRound: round };
  const next = intendDispatch("FIX_DISPATCH_INTENT")(advanced, event);
  return { ...next, fixRound: round, reviewOutcome: null };
};

/** Open the single permitted final-fix wave. */
const openFinalFix = (state, event) => {
  requirePinned(state);
  if (state.finalFixUsed) {
    fail("exactly one final-fix wave is permitted; a second is not legal");
  }
  const next = intendDispatch("FINAL_FIX_DISPATCH_INTENT")(state, event);
  return { ...next, finalFixUsed: true };
};

/** Complete the run. Requires final-review evidence and a reconciled ledger. */
const completeRun = (state, event) => {
  requirePinned(state);
  const outcome = state.reviewOutcome;
  if (outcome === null) fail("completion requires a recorded review result");
  if (outcome.specStatus !== "PASS" || outcome.qualityStatus !== "APPROVED") {
    fail(
      `completion requires final spec PASS and quality APPROVED, got ${outcome.specStatus}/${outcome.qualityStatus}`,
    );
  }
  const findings = applyResolutions(state.findings, event.findingResolutions, "findingResolutions");
  const residual = openFindings(findings);
  if (residual.length > 0) {
    fail(
      `completion requires every finding adjudicated; ${String(residual.length)} remain open, starting with ${residual[0].id}`,
    );
  }
  return { phase: "COMPLETE", findings };
};

/** Render the one-line audit record for a completed transition. */
const renderTransition = (state, eventType) =>
  `${AUDIT_MARKER} revision=${String(state.revision)} phase=${state.phase} event=${eventType} at=${state.updatedAt} -->`;

/** Handlers shared by every dispatch-intent phase. */
const intentHandlers = (intentPhase) => {
  const { running } = INTENT_PHASES[intentPhase];
  return {
    // Correlation only. The tool already ran; this records which child it made.
    "dispatch-started": (state, event) => ({
      phase: running,
      dispatch: { ...state.dispatch, sessionId: sessionIdOf(event.sessionId) },
    }),
    "dispatch-mismatch": (state, event) => ({
      phase: "DISPATCH_MISMATCH_BLOCKED",
      blockedReason: bounded(event.reason, "reason"),
    }),
    // The window between the spawn call and the correlation write cannot be
    // closed from here. It can only be made visible.
    "dispatch-window-crossed": (state, event) => ({
      phase: "DISPATCH_AMBIGUOUS",
      blockedReason: bounded(event.reason, "reason"),
      ambiguousIntentPhase: intentPhase,
    }),
  };
};

/** Build the dispatch-intent entry handler for one intent phase. */
const intendDispatch = (intentPhase) => (state, event) => ({
  phase: intentPhase,
  dispatch: buildIntent(state, event, intentPhase),
});

/**
 * Phase/event handlers.
 *
 * Exactly one handler is looked up per `(phase, event.type)` pair. A missing
 * entry is an illegal transition, so the legal set is whatever appears here and
 * nothing else. Each handler returns only the fields it changes.
 */
const HANDLERS = Object.freeze({
  CAPABILITY_CHECK: {
    "capability-confirmed": (state, event) => ({
      phase: "PLAN_VALIDATE",
      mode: enumerated(event.mode, ["exact", "tiered"], "mode"),
    }),
    "capability-missing": (state, event) => ({
      phase: "CAPABILITY_BLOCKED",
      blockedReason: bounded(event.reason, "reason"),
    }),
  },
  PLAN_VALIDATE: {
    // Validation pins evidence in place; it does not advance on its own. The
    // preflight result is a separate observation.
    "plan-valid": (state, event) => {
      if (event.planDigest !== state.planDigest) {
        fail("plan-valid digest does not match the pinned plan digest");
      }
      return { phase: "PLAN_VALIDATE", planValidated: true };
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
    "preflight-clean": (state) => {
      if (state.planValidated !== true) {
        fail("preflight-clean requires a validated plan");
      }
      return { phase: "WORKSPACE_READY" };
    },
    "preflight-conflict": (state, event) => {
      if (state.planValidated !== true) {
        fail("preflight-conflict requires a validated plan");
      }
      return {
        phase: "PREFLIGHT_DECISION_REQUIRED",
        blockedReason: bounded(event.reason, "reason"),
      };
    },
  },
  PREFLIGHT_DECISION_REQUIRED: {
    // A ruling must be persisted before work resumes. The reducer never infers
    // one from the absence of an objection.
    "preflight-approved": (state, event) => {
      bounded(event.reason, "reason");
      return { phase: "WORKSPACE_READY", blockedReason: null };
    },
    "preflight-rejected": (state, event) => ({
      phase: "FINAL_BLOCKED",
      blockedReason: `preflight rejected: ${bounded(event.reason, "reason")}`,
    }),
  },
  WORKSPACE_READY: {
    "implement-dispatch-intended": intendDispatch("IMPLEMENT_DISPATCH_INTENT"),
  },
  IMPLEMENT_DISPATCH_INTENT: intentHandlers("IMPLEMENT_DISPATCH_INTENT"),
  DISPATCH_AMBIGUOUS: {
    // The reducer never picks. Adoption names an observed child; reissue accepts
    // a possible orphan. Both are recorded decisions, not inferences.
    "dispatch-ruling-recorded": (state, event) => {
      bounded(event.reason, "reason");
      const intentPhase = state.ambiguousIntentPhase;
      const definition = INTENT_PHASES[intentPhase];
      if (definition === undefined) {
        fail("the ambiguous dispatch does not name a known intent phase");
      }
      if (event.decision === "adopt") {
        if (event.sessionId === undefined) {
          fail("a dispatch ruling that adopts a child requires its sessionId");
        }
        return {
          phase: definition.running,
          blockedReason: null,
          ambiguousIntentPhase: null,
          dispatch: { ...state.dispatch, sessionId: sessionIdOf(event.sessionId) },
        };
      }
      if (event.decision === "reissue") {
        if (event.sessionId !== undefined) {
          fail("a dispatch ruling that reissues must not name a sessionId");
        }
        return {
          phase: intentPhase,
          blockedReason: null,
          ambiguousIntentPhase: null,
          dispatch: { ...state.dispatch, sessionId: null, reissued: true },
        };
      }
      return fail(
        `dispatch-ruling-recorded requires decision "adopt" or "reissue", got ${String(event.decision)}`,
      );
    },
  },
  IMPLEMENT_RUNNING: {
    // Recording only. Classification is the next, separate transition.
    "implementer-finished": (state, event) => ({
      phase: "IMPLEMENT_RESULT",
      dispatch: pinResult(state, event),
    }),
  },
  IMPLEMENT_RESULT: {
    "implementer-status-recorded": (state, event) => {
      enumerated(event.status, IMPLEMENTER_STATUSES, "status");
      const concerns = normalizeConcerns(event.concerns);

      // A hedged status with nothing to adjudicate is worse than no hedge: it
      // costs the controller a decision point and gives it nothing to decide.
      // The role contract states this three ways and a live role still returned
      // DONE_WITH_CONCERNS with an empty concerns section, so it is enforced
      // here. This is the project's own thesis applied to itself: prose is
      // advice, a reducer is enforcement.
      if (event.status === "DONE_WITH_CONCERNS" && concerns.length === 0) {
        fail(
          "DONE_WITH_CONCERNS requires at least one concern; record DONE when there is nothing to adjudicate",
        );
      }

      const dispatch = { ...state.dispatch, status: event.status, concerns };

      if (event.status === "BLOCKED") {
        return {
          phase: "TASK_BLOCKED",
          dispatch,
          blockedReason: bounded(event.reason, "reason"),
        };
      }
      if (event.status === "NEEDS_CONTEXT") {
        return { phase: "CONTEXT_REQUIRED", dispatch };
      }
      const blocking = concerns.filter((concern) => concern.kind !== OBSERVATIONAL_CONCERN);
      if (blocking.length > 0) {
        return { phase: "CONCERN_DECISION_REQUIRED", dispatch };
      }
      return { phase: "IMPLEMENT_RESULT", dispatch, statusPinned: true };
    },
    "task-review-dispatch-intended": (state, event) => {
      if (state.statusPinned !== true) {
        fail("task review requires a pinned implementer status");
      }
      return intendDispatch("TASK_REVIEW_DISPATCH_INTENT")(state, event);
    },
  },
  CONTEXT_REQUIRED: {
    // Enrichment retries the same task at the planned tier. It is not a fix
    // round, so fixRound is untouched.
    "context-dispatch-intended": (state, event) => {
      if (state.contextAttempts >= MAX_CONTEXT_ATTEMPTS) {
        fail(
          `context enrichment is bounded at ${String(MAX_CONTEXT_ATTEMPTS)} attempts; the task must block instead`,
        );
      }
      const next = intendDispatch("IMPLEMENT_DISPATCH_INTENT")(
        { ...state, contextAttempts: state.contextAttempts + 1 },
        event,
      );
      return { ...next, contextAttempts: state.contextAttempts + 1, statusPinned: false };
    },
    "context-limit-reached": (state, event) => {
      if (state.contextAttempts < MAX_CONTEXT_ATTEMPTS) {
        fail("context-limit-reached is only legal once enrichment is exhausted");
      }
      return { phase: "TASK_BLOCKED", blockedReason: bounded(event.reason, "reason") };
    },
  },
  CONCERN_DECISION_REQUIRED: {
    "concern-ruling-recorded": (state, event) => {
      bounded(event.reason, "reason");
      if (event.decision === "proceed") {
        return { phase: "IMPLEMENT_RESULT", statusPinned: true };
      }
      if (event.decision === "block") {
        return { phase: "TASK_BLOCKED", blockedReason: event.reason };
      }
      return fail(
        `concern-ruling-recorded requires decision "proceed" or "block", got ${String(event.decision)}`,
      );
    },
  },
  TASK_REVIEW_DISPATCH_INTENT: intentHandlers("TASK_REVIEW_DISPATCH_INTENT"),
  TASK_REVIEW_RUNNING: {
    // The reviewer records evidence. It cannot select the next phase.
    "task-review-finished": (state, event) => ({
      phase: "TASK_REVIEW_DECISION",
      dispatch: pinResult(state, event),
      reviewOutcome: reviewOutcomeOf(event),
      findings: mergeFindings(state.findings, event.findings, "findings"),
    }),
  },
  TASK_REVIEW_DECISION: {
    "review-approved": (state, event) => approveTask(state, event),
    "fix-dispatch-intended": (state, event) => openFixRound(state, event),
    "review-blocked": (state, event) => ({
      phase: "TASK_BLOCKED",
      blockedReason: bounded(event.reason, "reason"),
    }),
  },
  FIX_DISPATCH_INTENT: intentHandlers("FIX_DISPATCH_INTENT"),
  FIX_RUNNING: {
    "rereview-dispatch-intended": (state, event) => {
      const resolved = applyResolutions(state.findings, event.findingResolutions, "findingResolutions");
      const next = intendDispatch("REREVIEW_DISPATCH_INTENT")(state, event);
      return { ...next, findings: resolved };
    },
    "fixer-blocked": (state, event) => ({
      phase: "TASK_BLOCKED",
      blockedReason: bounded(event.reason, "reason"),
    }),
  },
  REREVIEW_DISPATCH_INTENT: intentHandlers("REREVIEW_DISPATCH_INTENT"),
  REREVIEW_RUNNING: {
    // Pins the result only. Adjudication is the next, separate transition.
    "rereview-finished": (state, event) => {
      if (state.reviewOutcome?.pinned === true) {
        fail("rereview-finished has already pinned a result for this round");
      }
      return {
        phase: "REREVIEW_RUNNING",
        dispatch: pinResult(state, event),
        reviewOutcome: { ...reviewOutcomeOf(event), pinned: true },
        findings: mergeFindings(state.findings, event.findings, "findings"),
      };
    },
    "rereview-approved": (state, event) => {
      requirePinned(state);
      return approveTask(state, event);
    },
    "task-park-ruling-recorded": (state, event) => {
      requirePinned(state);
      bounded(event.reason, "reason");
      return {
        phase: "REREVIEW_RUNNING",
        findings: applyResolutions(state.findings, event.findingResolutions, "findingResolutions"),
      };
    },
    "next-fix-dispatch-intended": (state, event) => {
      requirePinned(state);
      return openFixRound(state, event);
    },
    "rereview-blocked": (state, event) => {
      requirePinned(state);
      return { phase: "TASK_BLOCKED", blockedReason: bounded(event.reason, "reason") };
    },
  },
  TASK_COMPLETE: {
    "next-task-ready": (state) => {
      if (state.currentTask >= state.tasks.length) {
        fail("next-task-ready is not legal on the last task; final review is required");
      }
      const nextTask = state.currentTask + 1;
      return {
        phase: "WORKSPACE_READY",
        currentTask: nextTask,
        // Derived only from the immutable plan index captured at initialization.
        currentImplementerTier: state.tasks[nextTask - 1].implementerTier,
        contextAttempts: 0,
        fixRound: 0,
        statusPinned: false,
        reviewOutcome: null,
        dispatch: null,
      };
    },
    "final-review-dispatch-intended": (state, event) => {
      if (state.currentTask !== state.tasks.length) {
        fail("final review is only legal after the last task completes");
      }
      // reviewOutcome must be cleared in the returned changes, not just on the
      // input clone, or the task-level verdict stays pinned and satisfies the
      // completion guard without a final verdict of its own.
      return {
        ...intendDispatch("FINAL_REVIEW_DISPATCH_INTENT")(state, event),
        reviewOutcome: null,
      };
    },
  },
  FINAL_REVIEW_DISPATCH_INTENT: intentHandlers("FINAL_REVIEW_DISPATCH_INTENT"),
  FINAL_REVIEW_RUNNING: {
    "final-review-finished": (state, event) => ({
      phase: "FINAL_REVIEW_RUNNING",
      dispatch: pinResult(state, event),
      reviewOutcome: { ...reviewOutcomeOf(event), pinned: true },
      findings: mergeFindings(state.findings, event.findings, "findings"),
    }),
    "final-complete": (state, event) => completeRun(state, event),
    "final-fix-dispatch-intended": (state, event) => openFinalFix(state, event),
    "final-blocked": (state, event) => {
      requirePinned(state);
      return { phase: "FINAL_BLOCKED", blockedReason: bounded(event.reason, "reason") };
    },
  },
  FINAL_FIX_DISPATCH_INTENT: intentHandlers("FINAL_FIX_DISPATCH_INTENT"),
  FINAL_FIX_RUNNING: {
    "final-rereview-dispatch-intended": (state, event) => {
      const resolved = applyResolutions(state.findings, event.findingResolutions, "findingResolutions");
      const next = intendDispatch("FINAL_REREVIEW_DISPATCH_INTENT")(state, event);
      return { ...next, findings: resolved, reviewOutcome: null };
    },
    "final-fixer-blocked": (state, event) => ({
      phase: "FINAL_BLOCKED",
      blockedReason: bounded(event.reason, "reason"),
    }),
  },
  FINAL_REREVIEW_DISPATCH_INTENT: intentHandlers("FINAL_REREVIEW_DISPATCH_INTENT"),
  FINAL_REREVIEW_RUNNING: {
    "final-rereview-finished": (state, event) => ({
      phase: "FINAL_REREVIEW_RUNNING",
      dispatch: pinResult(state, event),
      reviewOutcome: { ...reviewOutcomeOf(event), pinned: true },
      findings: mergeFindings(state.findings, event.findings, "findings"),
    }),
    "final-complete": (state, event) => completeRun(state, event),
    "final-park-ruling-recorded": (state, event) => {
      requirePinned(state);
      bounded(event.reason, "reason");
      return {
        phase: "FINAL_REREVIEW_RUNNING",
        findings: applyResolutions(state.findings, event.findingResolutions, "findingResolutions"),
      };
    },
    "final-blocked": (state, event) => {
      requirePinned(state);
      return { phase: "FINAL_BLOCKED", blockedReason: bounded(event.reason, "reason") };
    },
  },
});

/**
 * Exported transition metadata.
 *
 * The reference document and the table-driven completeness tests both read this
 * rather than asserting on source text, so the doc cannot drift from the code
 * without a test noticing.
 */
export const TRANSITIONS = Object.freeze(
  Object.entries(HANDLERS).flatMap(([phase, events]) =>
    Object.keys(events).map((event) => Object.freeze({ phase, event })),
  ),
);

/** Every event name the reducer accepts anywhere. */
export const EVENT_TYPES = Object.freeze([
  ...new Set([...TRANSITIONS.map((entry) => entry.event), "recovery-ruling-recorded"]),
]);

/**
 * Apply one typed event to a state document.
 *
 * The input is never mutated: the result is built from a structural clone, so a
 * caller holding the previous state keeps a stable value.
 */
export function reduceState(state, event) {
  validateState(state);
  if (event === null || typeof event !== "object") fail("event must be an object");
  if (typeof event.type !== "string" || event.type.length === 0) {
    fail("event.type must be a non-empty string");
  }

  const at = instant(event.at, "at");
  if (at < state.updatedAt) {
    fail(`event timestamp ${at} precedes the last transition at ${state.updatedAt}`);
  }

  // Recovery is legal in any nonterminal phase and never changes phase. It
  // records that a repair or lock decision was ruled on, so the audit trail
  // shows the intervention instead of hiding it.
  if (event.type === "recovery-ruling-recorded") {
    if (TERMINAL_SET.has(state.phase)) {
      fail(`recovery-ruling-recorded is not legal in terminal phase ${state.phase}`);
    }
    bounded(event.reason, "reason");
    bounded(event.receipt, "receipt");
    const recovered = {
      ...structuredClone(state),
      revision: state.revision + 1,
      recoveryRulings: state.recoveryRulings + 1,
      updatedAt: at,
    };
    recovered.lastTransition = renderTransition(recovered, event.type);
    return deepFreeze(validateState(recovered));
  }

  const byPhase = HANDLERS[state.phase];
  const handler = byPhase?.[event.type];
  if (!handler) {
    if (!EVENT_TYPES.includes(event.type)) fail(`unknown event type ${event.type}`);
    if (TERMINAL_SET.has(state.phase)) {
      fail(`phase ${state.phase} is terminal and accepts no continuation event`);
    }
    fail(`illegal transition: ${event.type} is not legal in phase ${state.phase}`);
  }

  const previous = structuredClone(state);
  const changes = handler(previous, event);

  const next = { ...previous, ...changes, revision: previous.revision + 1, updatedAt: at };
  next.lastTransition = renderTransition(next, event.type);

  return deepFreeze(validateState(next));
}
