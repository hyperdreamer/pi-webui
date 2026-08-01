/**
 * Facade and CLI for the deterministic SDD state helper.
 *
 * Importing this module has no side effects: it neither writes output nor sets an
 * exit code. All parsing and tier logic lives in `lib/plan-policy.mjs`; this file
 * only adapts that logic to argv.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parsePlanText, roleTier } from "./lib/plan-policy.mjs";
import {
  clearStaleLock,
  EXIT,
  initRun,
  lockStatus,
  repairAudit,
  show,
  StoreError,
  transition,
} from "./lib/state-store.mjs";

export {
  clearStaleLock,
  EXIT,
  initRun,
  lockStatus,
  repairAudit,
  show,
  StoreError,
  transition,
} from "./lib/state-store.mjs";

export {
  computeRunId,
  createInitialState,
  dispatchKeyFor,
  EVENT_TYPES,
  PHASES,
  reduceState,
  StateError,
  STATE_VERSION,
  TERMINAL_PHASES,
  TRANSITIONS,
  validateState,
} from "./lib/state-machine.mjs";

export {
  finalReviewerTier,
  fixerTier,
  parsePlanText,
  reReviewerTier,
  reviewerTier,
  roleTier,
  tierDirective,
  tierLabel,
  TIERS,
} from "./lib/plan-policy.mjs";

const USAGE = [
  "usage:",
  "  sdd-state validate-plan PLAN_FILE",
  "  sdd-state role-tier --implementer TIER --role ROLE [--round N]",
  "  sdd-state init --plan PLAN --state STATE --progress PROGRESS --repo-root ROOT",
  "                 --worktree TREE --branch BRANCH --base-ref REF --merge-base SHA",
  "  sdd-state show --state STATE --progress PROGRESS",
  "  sdd-state transition --state STATE --progress PROGRESS --plan PLAN",
  "                       --expected-revision N --event-file EVENT_JSON",
  "  sdd-state repair-audit --state STATE --progress PROGRESS",
  "  sdd-state lock-status --state STATE",
  "  sdd-state clear-stale-lock --state STATE --expected-owner-token TOKEN",
  "                             --decision-file DECISION_JSON",
].join("\n");

/** Require a set of flags, naming every missing one at once. */
function requireFlags(flags, names) {
  const missing = names.filter((name) => flags.get(name) === undefined);
  if (missing.length > 0) {
    throw new Error(`missing required flag(s): ${missing.map((n) => `--${n}`).join(", ")}\n${USAGE}`);
  }
  return Object.fromEntries(names.map((name) => [name, flags.get(name)]));
}

function parseFlags(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag ${token} requires a value`);
    }
    flags.set(token.slice(2), value);
    index += 1;
  }
  return flags;
}

function validatePlanCommand(args) {
  const planPath = args[0];
  if (planPath === undefined || args.length > 1) throw new Error(USAGE);

  const bytes = readFileSync(planPath);
  const parsed = parsePlanText(bytes.toString("utf8"), planPath);
  return {
    planPath,
    planDigest: createHash("sha256").update(bytes).digest("hex"),
    globalConstraints: parsed.globalConstraints,
    tasks: parsed.tasks.map((task) => ({
      number: task.number,
      title: task.title,
      implementerTier: task.implementerTier,
    })),
  };
}

function roleTierCommand(args) {
  const flags = parseFlags(args);
  const implementer = flags.get("implementer");
  const role = flags.get("role");
  if (implementer === undefined || role === undefined) throw new Error(USAGE);

  const rawRound = flags.get("round");
  if (rawRound === undefined) return roleTier({ implementer, role });

  if (!/^[0-9]+$/u.test(rawRound)) throw new Error(`fix round must be an integer: ${rawRound}`);
  return roleTier({ implementer, role, round: Number(rawRound) });
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "validate-plan":
      console.log(JSON.stringify(validatePlanCommand(args), null, 2));
      return 0;
    case "role-tier":
      console.log(JSON.stringify(roleTierCommand(args)));
      return 0;
    case "init": {
      const flags = parseFlags(args);
      const required = requireFlags(flags, [
        "plan",
        "state",
        "progress",
        "repo-root",
        "worktree",
        "branch",
        "base-ref",
        "merge-base",
      ]);
      const result = initRun({
        planPath: required.plan,
        statePath: required.state,
        progressPath: required.progress,
        repoRoot: required["repo-root"],
        worktree: required.worktree,
        branch: required.branch,
        baseRef: required["base-ref"],
        mergeBase: required["merge-base"],
      });
      console.log(JSON.stringify({ revision: result.state.revision, phase: result.state.phase }));
      return 0;
    }
    case "show": {
      const flags = parseFlags(args);
      const required = requireFlags(flags, ["state", "progress"]);
      const result = show({ statePath: required.state, progressPath: required.progress });
      console.log(JSON.stringify(result, null, 2));
      // A repairable ledger is reported through the exit code so a script does
      // not have to parse stdout to notice.
      return result.audit.status === "AUDIT_REPAIR_NEEDED"
        ? EXIT.AUDIT_REPAIR_NEEDED
        : result.audit.status === "AUDIT_CORRUPT"
          ? EXIT.IDENTITY
          : 0;
    }
    case "transition": {
      const flags = parseFlags(args);
      const required = requireFlags(flags, [
        "state",
        "progress",
        "plan",
        "expected-revision",
        "event-file",
      ]);
      const revision = required["expected-revision"];
      if (!/^[0-9]+$/u.test(revision)) {
        throw new Error(`--expected-revision must be a non-negative integer: ${revision}`);
      }
      const result = transition({
        statePath: required.state,
        progressPath: required.progress,
        planPath: required.plan,
        expectedRevision: Number(revision),
        eventFile: required["event-file"],
        worktree: flags.get("worktree"),
        branch: flags.get("branch"),
        mergeBase: flags.get("merge-base"),
      });
      console.log(JSON.stringify({ revision: result.state.revision, phase: result.state.phase }));
      return 0;
    }
    case "repair-audit": {
      const flags = parseFlags(args);
      const required = requireFlags(flags, ["state", "progress"]);
      console.log(
        JSON.stringify(repairAudit({ statePath: required.state, progressPath: required.progress })),
      );
      return 0;
    }
    case "lock-status": {
      const flags = parseFlags(args);
      const required = requireFlags(flags, ["state"]);
      console.log(JSON.stringify(lockStatus({ statePath: required.state })));
      return 0;
    }
    case "clear-stale-lock": {
      const flags = parseFlags(args);
      const required = requireFlags(flags, ["state", "expected-owner-token", "decision-file"]);
      console.log(
        JSON.stringify(
          clearStaleLock({
            statePath: required.state,
            expectedOwnerToken: required["expected-owner-token"],
            decisionFile: required["decision-file"],
          }),
        ),
      );
      return 0;
    }
    default:
      throw new Error(command === undefined ? USAGE : `unknown command: ${command}\n${USAGE}`);
  }
}

function isDirectExecution() {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  return pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // A StoreError carries the exit code its failure mode maps to; anything else
    // is a validation failure from argument handling.
    process.exitCode = error instanceof StoreError ? error.code : EXIT.VALIDATION;
  }
}
