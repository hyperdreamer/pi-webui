/**
 * Three-condition pressure evaluator for the deterministic SDD candidate skill.
 *
 * Conditions:
 *   no-guidance - no controller skill and no role prompt
 *   original    - the explicitly named original skill or role prompt
 *   candidate   - the candidate skill directory or rendered role prompt
 *
 * Every invocation runs in a fresh process with a fresh temporary agent profile,
 * a fresh fixture root, and no saved session. Nothing here writes outside the
 * requested output directory.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONDITIONS = new Set(["no-guidance", "original", "candidate"]);
const SUITES = new Set(["controller", "role"]);

const EVALUATOR_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT_RELATIVE = "optional-skills/subagent-driven-development";
const FAKE_TOOLS_RELATIVE = `${SKILL_ROOT_RELATIVE}/evals/fake-sdd-tools.mjs`;
const ORIGINAL_SKILL_DEFAULT = join(
  homedir(),
  ".pi/agent/skills/subagent-driven-development",
);

/** Non-secret profile files that may be copied into a temporary profile. */
const COPYABLE_PROFILE_FILES = ["models.json", "models-store.json"];

export function parseEvaluatorArgs(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected positional argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag ${token} requires a value`);
    }
    flags.set(token.slice(2), value);
    index += 1;
  }

  const condition = requireFlag(flags, "condition");
  if (!CONDITIONS.has(condition)) {
    throw new Error(`condition must be one of ${[...CONDITIONS].join(", ")}`);
  }

  const suite = flags.get("suite") ?? "controller";
  if (!SUITES.has(suite)) {
    throw new Error(`suite must be one of ${[...SUITES].join(", ")}`);
  }

  const repetitionsRaw = requireFlag(flags, "repetitions");
  if (!/^\d+$/u.test(repetitionsRaw) || Number(repetitionsRaw) < 1) {
    throw new Error("repetitions must be a positive integer");
  }

  const scenarioId = requireFlag(flags, "scenario");
  const model = requireFlag(flags, "model");
  const output = requireFlag(flags, "output");

  // Tests inject a root so assertions stay on relative arguments.
  const evaluatorRoot = flags.get("evaluator-root") ?? resolve(EVALUATOR_DIR, "../../..");
  const originalSkill = flags.get("original-skill") ?? ORIGINAL_SKILL_DEFAULT;

  const suiteFile = suite === "controller" ? "evals.json" : "role-evals.json";
  const scenario = loadScenario(join(EVALUATOR_DIR, suiteFile), scenarioId);

  return {
    condition,
    suite,
    scenarioId,
    scenario,
    repetitions: Number(repetitionsRaw),
    model,
    output,
    evaluatorRoot,
    originalSkill,
  };
}

/**
 * Replace `/eval/...` path tokens with per-repetition fixture paths.
 *
 * Only the token is rewritten. Every behavioral sentence in the prompt is left
 * byte-identical, so scenario semantics cannot drift when fixtures move.
 */
export function rewriteEvalTokens(prompt, fixtureDir) {
  return String(prompt).replaceAll(/\/eval(\/[A-Za-z0-9_.-]+)*/gu, (token) => {
    const relative = token.slice("/eval".length);
    return relative.length === 0 ? fixtureDir : `${fixtureDir}${relative}`;
  });
}

export function buildPiInvocation(args, repetition) {
  const runSuffix = `run-${String(repetition)}`;
  const sessionDir = `${args.output}/.sessions/${runSuffix}`;
  const profileDir = `${args.output}/.profiles/${runSuffix}`;
  const fixtureDir = `${args.output}/.fixtures/${runSuffix}`;

  const piArgs = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--session-dir", sessionDir,
    "--approve",
    "--no-skills",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-builtin-tools",
  ];

  // Guidance selection. The candidate skill and the original skill are mutually
  // exclusive, and no-guidance loads neither.
  if (args.suite === "controller") {
    if (args.condition === "candidate") {
      piArgs.push("--skill", SKILL_ROOT_RELATIVE);
    } else if (args.condition === "original") {
      piArgs.push("--skill", args.originalSkill);
    }
  } else if (args.condition !== "no-guidance") {
    // Role suites load no controller skill: role guidance is explicit system text.
    const promptRelative = args.condition === "candidate"
      ? `${SKILL_ROOT_RELATIVE}/${args.scenario.candidateRolePrompt}`
      : join(args.originalSkill, args.scenario.originalRolePrompt);
    piArgs.push("--append-system-prompt", promptRelative);
  }

  piArgs.push("--extension", FAKE_TOOLS_RELATIVE);
  piArgs.push("--model", args.model);
  piArgs.push(rewriteEvalTokens(args.scenario.prompt, fixtureDir));

  const readRoots = [
    `${SKILL_ROOT_RELATIVE}/SKILL.md`,
    `${SKILL_ROOT_RELATIVE}/references`,
    `${SKILL_ROOT_RELATIVE}/prompts`,
    fixtureDir,
  ].map((entry) => (isAbsolute(entry) ? entry : join(args.evaluatorRoot, entry)));
  // The fixture root is already absolute and must not be re-rooted.
  readRoots[readRoots.length - 1] = fixtureDir;

  const writePaths = args.suite === "role" && typeof args.scenario.allowedReportPath === "string"
    ? [join(fixtureDir, args.scenario.allowedReportPath)]
    : [];

  const env = {
    PI_CODING_AGENT_DIR: profileDir,
    SDD_EVAL_READ_ROOTS_JSON: JSON.stringify(readRoots),
    SDD_EVAL_WRITE_PATHS_JSON: JSON.stringify(writePaths),
    SDD_EVAL_TOOL_LOG: join(fixtureDir, "tool-log.jsonl"),
    SDD_EVAL_POLICY_MODE: args.scenario.policyMode ?? "tiered",
    SDD_EVAL_LADDER_VALID: String(args.scenario.ladderValid ?? true),
    SDD_EVAL_SPAWN_OUTCOME: args.scenario.spawnOutcome ?? "directive-applied",
    SDD_EVAL_CAPABILITY_MODE: args.scenario.capabilityMode ?? "complete",
  };

  if (args.suite === "role" && typeof args.scenario.roleToolMode === "string") {
    env.SDD_EVAL_ROLE_TOOL_MODE = args.scenario.roleToolMode;
  } else if (typeof args.scenario.roleToolMode === "string") {
    env.SDD_EVAL_ROLE_TOOL_MODE = args.scenario.roleToolMode;
  }

  return { command: "pi", args: piArgs, env, sessionDir, profileDir, fixtureDir };
}

export function inspectPiJsonEvents(lines) {
  const source = Array.isArray(lines) ? lines : String(lines).split("\n");
  const toolCalls = [];
  const assistantText = [];
  let harnessBlocked = false;
  let provider = null;
  let model = null;
  let sawAgentEnd = false;

  for (const line of source) {
    const trimmed = String(line).trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      toolCalls.push({ name: event.toolName, args: event.args ?? null });
      continue;
    }

    if (event.type === "agent_end") sawAgentEnd = true;

    // Score assistant prose only from completed assistant messages, never from
    // echoed prompts, tool inputs, tool results, or serialized reasoning.
    const message = event.message;
    if (event.type !== "message_end" || message === undefined || message === null) continue;
    if (message.role !== "assistant") continue;

    if (typeof message.provider === "string") provider = message.provider;
    if (typeof message.model === "string") model = message.model;
    if (message.stopReason === "error") harnessBlocked = true;

    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((part) => part !== null && typeof part === "object" && part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("");
    if (text.length > 0) assistantText.push(text);
  }

  const finalText = assistantText.length > 0 ? assistantText[assistantText.length - 1] : "";
  if (assistantText.length === 0) harnessBlocked = true;

  return {
    toolCalls,
    toolNames: toolCalls.map((call) => call.name),
    assistantText,
    finalText,
    provider,
    model,
    sawAgentEnd,
    status: harnessBlocked ? "HARNESS_BLOCKED" : "SCORED",
  };
}

export function scoreRun(scenario, inspection) {
  if (inspection.status === "HARNESS_BLOCKED") {
    return { status: "HARNESS_BLOCKED", expectedStateMatch: false, outputSchemaMatch: false };
  }

  const text = inspection.finalText;
  const expectedStateMatch = typeof scenario.expectedState === "string"
    ? text.includes(scenario.expectedState)
    : false;

  const required = scenario.requiredToolCalls ?? [];
  const forbidden = scenario.forbiddenToolCalls ?? [];
  const missingRequiredCalls = required.filter((name) => !inspection.toolNames.includes(name));
  const forbiddenCallsMade = forbidden.filter((name) => inspection.toolNames.includes(name));

  const readArgs = inspection.toolCalls
    .filter((call) => call.name === "read")
    .map((call) => String(call.args?.path ?? ""));
  const missingReadSuffixes = (scenario.requiredReadSuffixes ?? [])
    .filter((suffix) => !readArgs.some((path) => path.endsWith(suffix)));

  return {
    status: "SCORED",
    expectedStateMatch,
    outputSchemaMatch: text.trim().length > 0,
    missingRequiredCalls,
    forbiddenCallsMade,
    missingReadSuffixes,
  };
}

function requireFlag(flags, name) {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function loadScenario(suitePath, scenarioId) {
  const parsed = JSON.parse(readFileSync(suitePath, "utf8"));
  const scenario = parsed.scenarios.find((entry) => entry.id === scenarioId);
  if (scenario === undefined) throw new Error(`unknown scenario: ${scenarioId}`);
  return scenario;
}

export function seedTemporaryProfile(profileDir, sourceProfileDir) {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  chmodSync(profileDir, 0o700);

  // Credentials are symlinked, never copied, so no secret bytes land in results.
  const authSource = join(sourceProfileDir, "auth.json");
  if (existsSync(authSource)) {
    const authTarget = join(profileDir, "auth.json");
    if (!existsSync(authTarget)) symlinkSync(authSource, authTarget);
  }

  for (const name of COPYABLE_PROFILE_FILES) {
    const source = join(sourceProfileDir, name);
    if (!existsSync(source)) continue;
    const target = join(profileDir, name);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }

  return profileDir;
}

export function removeTemporaryProfile(profileDir) {
  rmSync(profileDir, { recursive: true, force: true });
}

/**
 * Materialize a repetition's fixture root and pre-seed any scripted dispatch
 * registry the scenario requires, so a recovery scenario can observe a genuine
 * prior dispatch rather than a fresh one.
 */
export function prepareRepetitionWorkspace(args, invocation) {
  mkdirSync(invocation.fixtureDir, { recursive: true });
  writeScenarioFixtures(args.scenario, invocation.fixtureDir);

  const seed = args.scenario.seedDispatchRegistry;
  if (seed === undefined) return invocation.fixtureDir;

  // The seeded cwd and prompt must match what the controller will reissue, so
  // `/eval` tokens are rewritten here exactly as they are in the prompt.
  const registryPath = join(invocation.fixtureDir, "dispatch-registry.json");
  const cwd = rewriteEvalTokens(seed.cwd, invocation.fixtureDir);
  const renderedPrompt = rewriteEvalTokens(seed.renderedPrompt, invocation.fixtureDir);
  const registry = {
    [seed.key]: {
      cwd,
      normalizedPrompt: renderedPrompt.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n").trim(),
      sessionId: seed.sessionId,
      policyApplication: seed.policyApplication,
    },
  };
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return invocation.fixtureDir;
}

function runRepetition(args, repetition) {
  const invocation = buildPiInvocation(args, repetition);
  const sourceProfile = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");

  prepareRepetitionWorkspace(args, invocation);
  seedTemporaryProfile(invocation.profileDir, sourceProfile);

  const cleanup = () => { removeTemporaryProfile(invocation.profileDir); };
  const onSignal = () => { cleanup(); process.exit(130); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: args.evaluatorRoot,
      encoding: "utf8",
      env: { ...process.env, ...invocation.env },
    });
    const inspection = inspectPiJsonEvents(String(result.stdout ?? ""));
    const score = scoreRun(args.scenario, inspection);
    const record = {
      condition: args.condition,
      suite: args.suite,
      scenario: args.scenarioId,
      model: args.model,
      repetition,
      exitStatus: result.status,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      toolCalls: inspection.toolCalls,
      provider: inspection.provider,
      resolvedModel: inspection.model,
      ...score,
      at: new Date().toISOString(),
    };
    const reportPath = join(
      args.output,
      `${args.condition}--${args.scenarioId}--run-${String(repetition)}.json`,
    );
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    cleanup();
  }
}

function writeScenarioFixtures(scenario, fixtureDir) {
  const fixtures = scenario.fixtures ?? {};
  for (const [relative, content] of Object.entries(fixtures)) {
    const target = join(fixtureDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(content));
  }
}

function main(argv) {
  if (argv[0] === "inspect-json") {
    const requireText = [];
    const requireTool = [];
    const forbidTool = [];
    for (let index = 1; index < argv.length; index += 1) {
      const token = argv[index];
      const value = argv[index + 1];
      if (token === "--require-text" && value !== undefined) { requireText.push(value); index += 1; }
      else if (token === "--require-tool" && value !== undefined) { requireTool.push(value); index += 1; }
      else if (token === "--forbid-tool" && value !== undefined) { forbidTool.push(value); index += 1; }
      else throw new Error(`unexpected inspect-json argument: ${token}`);
    }
    const inspection = inspectPiJsonEvents(readFileSync(0, "utf8"));
    const failures = [
      ...requireText.filter((text) => !inspection.finalText.includes(text))
        .map((text) => `missing required text: ${text}`),
      ...requireTool.filter((tool) => !inspection.toolNames.includes(tool))
        .map((tool) => `missing required tool call: ${tool}`),
      ...forbidTool.filter((tool) => inspection.toolNames.includes(tool))
        .map((tool) => `forbidden tool call made: ${tool}`),
    ];
    console.log(JSON.stringify({ ...inspection, failures }, null, 2));
    return failures.length === 0 ? 0 : 1;
  }

  const args = parseEvaluatorArgs(argv);
  mkdirSync(args.output, { recursive: true });
  let failures = 0;
  for (let repetition = 1; repetition <= args.repetitions; repetition += 1) {
    const record = runRepetition(args, repetition);
    if (record.status !== "SCORED") failures += 1;
    console.log(`[eval] ${args.condition} ${args.scenarioId} run-${String(repetition)}: ${record.status}`);
  }
  return failures === 0 ? 0 : 1;
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
    console.error(`[eval] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
