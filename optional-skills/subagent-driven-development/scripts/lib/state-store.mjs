/**
 * Durable state persistence for the deterministic SDD controller.
 *
 * The reducer decides *what* a transition means. This module decides *when it is
 * durable*, which is a different problem with different failure modes: torn
 * writes, concurrent controllers, and a crash between the state write and the
 * audit append.
 *
 * `state.json` is canonical and the progress ledger is derived from it. Every
 * mutation therefore follows one order, and no step is optional:
 *
 *   acquire lock -> reread state -> verify identity -> check expected revision
 *   -> reduce in memory -> write+fsync temp -> rename -> fsync dir
 *   -> append+fsync one audit line -> release lock
 *
 * Locking uses `link()` rather than `O_EXCL` on the lock path itself, so the
 * owner record is complete on disk *before* the lock becomes visible. Acquiring
 * with `O_EXCL` and then writing metadata leaves a window where another process
 * sees a lock it cannot attribute, which is indistinguishable from corruption.
 *
 * Filesystem, clock, and identity are injected. The CLI owns Git subprocesses and
 * supplies observed identity; the store never shells out, and callers never
 * supply transition timestamps or lock tokens.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

import { createInitialState, reduceState, validateState } from "./state-machine.mjs";
import { parsePlanText } from "./plan-policy.mjs";

/** Exit codes. The CLI surfaces these directly, so they are part of the contract. */
export const EXIT = Object.freeze({
  OK: 0,
  VALIDATION: 2,
  CONTENTION: 3,
  IDENTITY: 4,
  AUDIT_REPAIR_NEEDED: 5,
  UNRESOLVED_LOCK: 6,
});

/** Maximum bytes for an event or decision JSON file. */
const MAX_EVENT_BYTES = 64 * 1024;

/** The audit-line marker, matching the reducer's rendered transition. */
const AUDIT_MARKER = "<!-- sdd-transition:";

/** A failure carrying the exit code the CLI should use. */
export class StoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

const failWith = (code, message) => {
  throw new StoreError(message, code);
};

/** Default adapters. Tests replace these to inject failures or fixed values. */
export const defaultAdapters = Object.freeze({
  now: () => new Date().toISOString().replace(/\.\d+Z$/u, ".000Z"),
  token: () => randomUUID().replaceAll("-", ""),
  pid: () => process.pid,
  host: () => hostname(),
  rename: renameSync,
});

/** Write a file and fsync it, so its bytes survive a power loss. */
const writeSynced = (path, contents) => {
  const handle = openSync(path, "w");
  try {
    writeSync(handle, contents);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
};

/** Append one line and fsync. */
const appendSynced = (path, line) => {
  const handle = openSync(path, "a");
  try {
    writeSync(handle, line);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
};

/** fsync a directory so a rename within it is durable. */
const syncDirectory = (path) => {
  const handle = openSync(path, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
};

const lockPathFor = (statePath) => `${statePath}.lock`;

/**
 * Acquire the run lock.
 *
 * The owner record is written to a unique sibling and then hard-linked to the
 * fixed lock path, so the lock is never visible in a metadata-empty state. The
 * unique file is removed either way: on success it has served its purpose, and on
 * contention it would otherwise leak.
 */
const acquireLock = (statePath, adapters) => {
  const lockPath = lockPathFor(statePath);
  const owner = {
    token: adapters.token(),
    pid: adapters.pid(),
    host: adapters.host(),
    at: adapters.now(),
  };
  const uniquePath = `${lockPath}.${owner.token}`;
  writeSynced(uniquePath, `${JSON.stringify(owner)}\n`);
  try {
    linkSync(uniquePath, lockPath);
  } catch (error) {
    rmSync(uniquePath, { force: true });
    if (error.code === "EEXIST") {
      failWith(EXIT.CONTENTION, `the run is locked by another process: ${lockPath}`);
    }
    throw error;
  }
  rmSync(uniquePath, { force: true });
  return owner;
};

const releaseLock = (statePath) => {
  rmSync(lockPathFor(statePath), { force: true });
};

/** Read the current lock owner, or null when unlocked. */
export const readLockOwner = (statePath) => {
  try {
    return JSON.parse(readFileSync(lockPathFor(statePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // A malformed lock is reported, never silently cleared: a lock we cannot
    // attribute is exactly the case that needs a human ruling.
    failWith(EXIT.UNRESOLVED_LOCK, `the lock file is unreadable: ${lockPathFor(statePath)}`);
  }
  return null;
};

/** Is the recorded owner still alive on this host? */
const ownerIsLive = (owner, adapters) => {
  if (owner === null) return false;
  if (owner.host !== adapters.host()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const readJsonFile = (path, field) => {
  let raw;
  try {
    raw = readFileSync(path);
  } catch {
    failWith(EXIT.VALIDATION, `${field} is not readable: ${path}`);
  }
  if (raw.byteLength > MAX_EVENT_BYTES) {
    failWith(EXIT.VALIDATION, `${field} exceeds ${String(MAX_EVENT_BYTES)} bytes (64 KiB)`);
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return failWith(EXIT.VALIDATION, `${field} is not valid JSON: ${path}`);
  }
};

/**
 * Load and validate persisted state.
 *
 * A state document that fails validation is corruption, not a validation error
 * the caller can fix by passing different arguments, so it exits 4.
 */
const loadState = (statePath) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      failWith(EXIT.VALIDATION, `no state file at ${statePath}; run init first`);
    }
    return failWith(EXIT.IDENTITY, `the state file is unreadable or malformed: ${statePath}`);
  }
  try {
    return validateState(parsed);
  } catch (error) {
    return failWith(EXIT.IDENTITY, `the state file is invalid: ${error.message}`);
  }
};

/** Recompute the plan digest and compare pinned Git identity. */
const verifyIdentity = (state, { planPath, worktree, branch, mergeBase }) => {
  let bytes;
  try {
    bytes = readFileSync(planPath);
  } catch {
    failWith(EXIT.IDENTITY, `the pinned plan file is missing: ${planPath}`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== state.planDigest) {
    failWith(
      EXIT.IDENTITY,
      `the plan digest changed under the run: pinned ${state.planDigest.slice(0, 12)}, observed ${digest.slice(0, 12)}`,
    );
  }
  for (const [field, observed, pinned] of [
    ["worktree", worktree, state.worktree],
    ["branch", branch, state.branch],
    ["merge-base", mergeBase, state.mergeBase],
  ]) {
    if (observed !== undefined && observed !== pinned) {
      failWith(EXIT.IDENTITY, `${field} drifted: pinned ${pinned}, observed ${observed}`);
    }
  }
};

/** Confine a path beneath a root, so an event file cannot come from anywhere. */
const requireBeneath = (path, root, field) => {
  const absolute = resolve(path);
  if (absolute !== resolve(root) && !absolute.startsWith(`${resolve(root)}/`)) {
    failWith(EXIT.VALIDATION, `${field} must live beneath the run root ${root}`);
  }
  return absolute;
};

/** Initialize a run. Fails if state already exists, so a rerun cannot reset it. */
export function initRun(options, adapters = defaultAdapters) {
  const { planPath, statePath, progressPath, repoRoot, worktree, branch, baseRef, mergeBase } =
    options;

  if (existsPath(statePath)) {
    failWith(EXIT.VALIDATION, `a run is already initialized at ${statePath}`);
  }

  let bytes;
  try {
    bytes = readFileSync(planPath);
  } catch {
    return failWith(EXIT.VALIDATION, `no such plan file: ${planPath}`);
  }

  let parsed;
  try {
    parsed = parsePlanText(bytes.toString("utf8"), planPath);
  } catch (error) {
    return failWith(EXIT.VALIDATION, error.message);
  }

  const at = adapters.now();
  let state;
  try {
    state = createInitialState({
      planPath: resolve(planPath),
      planDigest: createHash("sha256").update(bytes).digest("hex"),
      repoRoot: resolve(repoRoot),
      worktree: resolve(worktree),
      runRoot: resolve(dirname(statePath)),
      branch,
      baseRef,
      mergeBase,
      tasks: parsed.tasks.map((task) => ({
        number: task.number,
        implementerTier: task.implementerTier,
      })),
      at,
    });
  } catch (error) {
    return failWith(EXIT.VALIDATION, error.message);
  }

  mkdirSync(dirname(statePath), { recursive: true });
  const owner = acquireLock(statePath, adapters);
  try {
    // Re-check under the lock: two concurrent inits must not both proceed.
    if (existsPath(statePath)) {
      failWith(EXIT.VALIDATION, `a run is already initialized at ${statePath}`);
    }
    commitState(statePath, progressPath, state, adapters, `# SDD ledger — plan: ${planPath}\n`);
  } finally {
    releaseLock(statePath);
  }
  return { state, owner: owner.token };
}

const existsPath = (path) => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Durably replace state and append its audit line.
 *
 * Temp-write, fsync, rename, fsync directory, then append. The append is last so
 * a crash can only ever leave the ledger *behind* canonical state, which
 * `repair-audit` can fix. The reverse order would leave a marker for a
 * transition that never became durable, which is unrepairable.
 */
const commitState = (statePath, progressPath, state, adapters, ledgerHeader = null) => {
  const temporaryPath = `${statePath}.tmp.${adapters.token()}`;
  writeSynced(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  try {
    adapters.rename(temporaryPath, statePath);
  } catch (error) {
    // The prior state is still intact because the rename never happened.
    rmSync(temporaryPath, { force: true });
    failWith(EXIT.IDENTITY, `could not durably replace state: ${error.message}`);
  }
  syncDirectory(dirname(statePath));

  if (ledgerHeader !== null && !existsPath(progressPath)) {
    writeSynced(progressPath, ledgerHeader);
  }
  appendSynced(progressPath, `${state.lastTransition}\n`);
};

/** Apply one event under the lock at an exact expected revision. */
export function transition(options, adapters = defaultAdapters) {
  const { statePath, progressPath, planPath, expectedRevision, eventFile, worktree, branch, mergeBase } =
    options;

  const state = loadState(statePath);
  const eventPath = requireBeneath(eventFile, state.runRoot, "--event-file");
  const event = readJsonFile(eventPath, "the event file");

  // The store owns time. A caller-supplied timestamp would let a stuck
  // controller manufacture ordering.
  if (event.at !== undefined) {
    failWith(
      EXIT.VALIDATION,
      "the event file must not carry a transition timestamp; the store supplies it",
    );
  }

  const owner = acquireLock(statePath, adapters);
  try {
    const current = loadState(statePath);
    verifyIdentity(current, { planPath, worktree, branch, mergeBase });

    if (current.revision !== expectedRevision) {
      failWith(
        EXIT.CONTENTION,
        `expected revision ${String(expectedRevision)} but found ${String(current.revision)}`,
      );
    }

    let next;
    try {
      next = reduceState(current, { ...event, at: adapters.now() });
    } catch (error) {
      return failWith(EXIT.VALIDATION, error.message);
    }

    commitState(statePath, progressPath, next, adapters);
    return { state: next, owner: owner.token };
  } finally {
    releaseLock(statePath);
  }
}

/** Count audit markers in the ledger. */
const auditMarkers = (progressPath) => {
  try {
    return readFileSync(progressPath, "utf8")
      .split("\n")
      .filter((line) => line.includes(AUDIT_MARKER));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

/**
 * Report state and audit health without writing anything.
 *
 * `show` never recommends repair while a live lock exists, because the apparent
 * gap is far more likely to be a transition in progress than corruption.
 */
export function show(options, adapters = defaultAdapters) {
  const { statePath, progressPath } = options;
  const state = loadState(statePath);
  const markers = auditMarkers(progressPath);
  const owner = readLockOwner(statePath);
  const locked = ownerIsLive(owner, adapters);

  const expected = state.revision + 1;
  let audit;
  if (locked) {
    audit = { status: "RUN_LOCKED", owner: { host: owner.host, pid: owner.pid, at: owner.at } };
  } else if (markers.length === expected) {
    audit = { status: "OK", markers: markers.length };
  } else if (markers.length === expected - 1) {
    audit = { status: "AUDIT_REPAIR_NEEDED", markers: markers.length, expected };
  } else {
    audit = { status: "AUDIT_CORRUPT", markers: markers.length, expected };
  }

  // A dispatch intent with no recorded session id is the unclosable spawn
  // window. Recovery must see it named, not infer it from a phase.
  const ambiguous =
    state.phase === "DISPATCH_AMBIGUOUS" ||
    (state.dispatch !== null &&
      state.dispatch.sessionId === null &&
      state.phase.endsWith("_DISPATCH_INTENT"));

  return {
    state,
    audit,
    lock: owner === null ? { status: "UNLOCKED" } : { status: locked ? "LIVE" : "STALE", owner },
    dispatch:
      state.dispatch === null
        ? null
        : {
            dispatchKey: state.dispatch.dispatchKey,
            role: state.dispatch.role,
            tier: state.dispatch.tier,
            sessionId: state.dispatch.sessionId,
            renderedPromptBytes: Buffer.byteLength(state.dispatch.renderedPrompt ?? "", "utf8"),
            ambiguous,
          },
    nextAction: ambiguous
      ? "record a dispatch ruling: adopt an observed session id, or reissue the stored prompt bytes"
      : null,
  };
}

/** Append the one missing audit marker, projecting only `lastTransition`. */
export function repairAudit(options, adapters = defaultAdapters) {
  const { statePath, progressPath } = options;
  const owner = readLockOwner(statePath);
  if (ownerIsLive(owner, adapters)) {
    failWith(EXIT.CONTENTION, "the run is locked; repair is not safe while a transition may be live");
  }

  const acquired = acquireLock(statePath, adapters);
  try {
    const state = loadState(statePath);
    const markers = auditMarkers(progressPath);
    const expected = state.revision + 1;
    if (markers.length === expected) {
      return { repaired: false, markers: markers.length };
    }
    if (markers.length !== expected - 1) {
      failWith(
        EXIT.IDENTITY,
        `the ledger holds ${String(markers.length)} markers but ${String(expected)} are expected; this is corruption, not a missing marker`,
      );
    }
    appendSynced(progressPath, `${state.lastTransition}\n`);
    return { repaired: true, markers: markers.length + 1, owner: acquired.token };
  } finally {
    releaseLock(statePath);
  }
}

/** Report lock status without changing it. */
export function lockStatus(options, adapters = defaultAdapters) {
  const owner = readLockOwner(options.statePath);
  if (owner === null) return { status: "UNLOCKED" };
  return { status: ownerIsLive(owner, adapters) ? "LIVE" : "STALE", owner };
}

/**
 * Clear a stale lock.
 *
 * Never guesses. Requires the exact owner token, the same host, a dead PID, and a
 * persisted decision file. A lock held by a live process, or by another host
 * where liveness cannot be checked, is left alone.
 */
export function clearStaleLock(options, adapters = defaultAdapters) {
  const { statePath, expectedOwnerToken, decisionFile } = options;
  const owner = readLockOwner(statePath);
  if (owner === null) return { cleared: false, reason: "the run is not locked" };

  const decision = readJsonFile(decisionFile, "the decision file");
  for (const field of ["action", "ownerToken", "reason", "approvedAt"]) {
    if (typeof decision[field] !== "string" || decision[field].length === 0) {
      failWith(EXIT.VALIDATION, `the decision file requires a non-empty ${field}`);
    }
  }
  if (decision.action !== "clear-stale-lock") {
    failWith(EXIT.VALIDATION, `the decision action must be "clear-stale-lock"`);
  }
  if (decision.ownerToken !== expectedOwnerToken || owner.token !== expectedOwnerToken) {
    failWith(EXIT.UNRESOLVED_LOCK, "the owner token does not match the lock on disk");
  }
  if (owner.host !== adapters.host()) {
    failWith(
      EXIT.UNRESOLVED_LOCK,
      `the lock is held on ${owner.host}; liveness cannot be checked from ${adapters.host()}`,
    );
  }
  if (ownerIsLive(owner, adapters)) {
    failWith(EXIT.UNRESOLVED_LOCK, `the lock owner (pid ${String(owner.pid)}) is still alive`);
  }

  unlinkSync(lockPathFor(statePath));
  return {
    cleared: true,
    receipt: `cleared lock token ${owner.token.slice(0, 12)} held by dead pid ${String(owner.pid)} on ${owner.host}; approved ${decision.approvedAt}`,
  };
}
