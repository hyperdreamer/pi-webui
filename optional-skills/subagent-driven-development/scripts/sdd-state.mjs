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

export {
  finalReviewerTier,
  fixerTier,
  parsePlanText,
  reReviewerTier,
  reviewerTier,
  roleTier,
  tierDirective,
  TIERS,
} from "./lib/plan-policy.mjs";

const USAGE = [
  "usage:",
  "  sdd-state validate-plan PLAN_FILE",
  "  sdd-state role-tier --implementer TIER --role ROLE [--round N]",
].join("\n");

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
    process.exitCode = 2;
  }
}
