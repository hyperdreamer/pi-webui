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

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative as relative_, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONDITIONS = new Set(["no-guidance", "original", "candidate"]);

/**
 * A phase-shaped token: SCREAMING_SNAKE_CASE with at least two segments.
 *
 * Deliberately not built from the reducer's PHASES list. Scoring must be able to
 * see an *invented* token -- that was the most common baseline failure -- so this
 * matches the shape a controller would report and lets comparison decide whether
 * it is real. Anchoring to the known set would silently skip an invented token and
 * score some legitimate phase named later in the justification.
 */
const PHASE_TOKEN_SOURCE = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";

/** A token standing alone on a line, optionally wrapped in emphasis or backticks. */
const STANDALONE_STATE_PATTERN = new RegExp(
  `^[ \\t>*_\`#]*(${PHASE_TOKEN_SOURCE})[ \\t\`*_.:]*$`,
  "mu",
);

/**
 * An explicit label followed by the token, e.g. "**Controller state token:**
 * `TASK_BLOCKED`" or "## State: `CAPABILITY_BLOCKED`".
 *
 * A colon is required. An earlier version allowed any run of non-alphanumeric
 * characters as the separator, so prose ending in "...changes the phase." matched
 * the label and then captured the first token of the *next* sentence -- usually the
 * phase being ruled out. That misread three correct runs. Emphasis and backticks
 * are permitted on either side of the colon because real answers use them.
 */
const LABELLED_STATE_PATTERN = new RegExp(
  `(?:state|token|phase)[\`*_ \\t]*:[\`*_ \\t]*(${PHASE_TOKEN_SOURCE})`,
  "iu",
);

const PHASE_TOKEN_PATTERN = new RegExp(`\\b${PHASE_TOKEN_SOURCE}\\b`, "u");

/**
 * The phase a run reports, read the way a human reviewer would.
 *
 * Order matters, and is driven by how real answers are shaped:
 *
 *   1. A token alone on its own line. Every controller prompt asks for the state
 *      token, and leading with it is the most common correct shape.
 *   2. An explicitly labelled token, for answers that open with prose.
 *   3. The first phase-shaped token anywhere, as a last resort.
 *
 * Standalone beats labelled because a correct answer often leads with the token and
 * *then* discusses the phase it ruled out. Justification must never outvote the
 * answer, and a bare substring test cannot tell "the phase is X" from "X does not
 * apply here".
 */
export function reportedStateOf(text) {
  return (
    STANDALONE_STATE_PATTERN.exec(text)?.[1] ??
    LABELLED_STATE_PATTERN.exec(text)?.[1] ??
    PHASE_TOKEN_PATTERN.exec(text)?.[0] ??
    ""
  );
}
const SUITES = new Set(["controller", "role"]);

const EVALUATOR_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT_RELATIVE = "optional-skills/deterministic-subagent-driven-development";
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

/**
 * Append the exact fixture paths available to the role, plus the single path its
 * report must be written to, so it can act without guessing. The role prompts
 * say "the supplied task brief" and "the required structured report" but name no
 * paths, and the fixture root is a fresh directory per repetition.
 *
 * The manifest lists paths only. It must never carry expected outcomes.
 */
function buildRolePromptWithManifest(prompt, fixtureDir, scenario) {
  const sections = [];

  const fixturePaths = Object.keys(scenario.fixtures ?? {});
  if (fixturePaths.length > 0) {
    const listed = fixturePaths.map((relative) => `  - ${join(fixtureDir, relative)}`).join("\n");
    sections.push(`## Available fixture files\n\n${listed}`);
  }

  if (typeof scenario.allowedReportPath === "string") {
    sections.push(`## Report path\n\nWrite your report to exactly this path:\n\n  ${join(fixtureDir, scenario.allowedReportPath)}`);
  }

  if (typeof scenario.editableFixture === "string") {
    sections.push(`## Editable file\n\nOnly this file may be edited:\n\n  ${join(fixtureDir, scenario.editableFixture)}`);
  }

  const allowlist = scenario.commandAllowlist ?? [];
  if (allowlist.length > 0) {
    const listed = allowlist.map((command) => `  - ${command}`).join("\n");
    sections.push(`## Allowed commands\n\nOnly these exact commands may be run:\n\n${listed}`);
  }

  return sections.length === 0 ? prompt : `${prompt}\n\n${sections.join("\n\n")}`;
}

export function buildPiInvocation(args, repetition) {
  const runSuffix = `run-${String(repetition)}`;
  // Scenario id is part of every per-run path. Keying on repetition alone let
  // scenarios sharing an output directory inherit each other's fixture files,
  // which then scored as unauthorized mutations against whichever scenario ran
  // second.
  const scope = `${args.scenarioId}/${runSuffix}`;
  const sessionDir = `${args.output}/.sessions/${scope}`;
  const profileDir = `${args.output}/.profiles/${scope}`;
  const fixtureDir = `${args.output}/.fixtures/${scope}`;
  let rolePromptSource = null;

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
      piArgs.push("--skill", join(args.evaluatorRoot, SKILL_ROOT_RELATIVE));
    } else if (args.condition === "original") {
      piArgs.push("--skill", args.originalSkill);
    }
  } else if (args.condition !== "no-guidance") {
    // Role suites load no controller skill: role guidance is explicit system text.
    // Pi reads --append-system-prompt as file contents when the value is an
    // existing path, so the path must resolve from the evaluator root.
    const promptPath = args.condition === "candidate"
      ? join(args.evaluatorRoot, SKILL_ROOT_RELATIVE, args.scenario.candidateRolePrompt)
      : resolve(args.originalSkill, args.scenario.originalRolePrompt);
    piArgs.push("--append-system-prompt", promptPath);
    rolePromptSource = promptPath;
  }

  piArgs.push("--extension", join(args.evaluatorRoot, FAKE_TOOLS_RELATIVE));
  piArgs.push("--model", args.model);

  // For role suites, append a fixture manifest so the model can discover the
  // exact available paths without guessing. The prompt body never names paths —
  // it says "the supplied task brief" — and the fixture root is ephemeral.
  const prompt = rewriteEvalTokens(args.scenario.prompt, fixtureDir);
  const delivered = args.suite === "role"
    ? buildRolePromptWithManifest(prompt, fixtureDir, args.scenario)
    : prompt;
  piArgs.push(delivered);

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

  if (typeof args.scenario.childTierOverride === "string") {
    // Makes the child's projected application disagree with the parent result,
    // which is the condition the dispatch-mismatch scenario exists to test.
    env.SDD_EVAL_CHILD_TIER_OVERRIDE = args.scenario.childTierOverride;
  }

  if (typeof args.scenario.editableFixture === "string") {
    env.SDD_EVAL_EDITABLE_FIXTURE = join(fixtureDir, args.scenario.editableFixture);
  }
  if (Array.isArray(args.scenario.commandAllowlist)) {
    env.SDD_EVAL_COMMAND_ALLOWLIST_JSON = JSON.stringify(args.scenario.commandAllowlist);
  }

  return { command: "pi", args: piArgs, env, sessionDir, profileDir, fixtureDir, rolePromptSource };
}

/**
 * Options for the Pi child process.
 *
 * `maxBuffer` is raised well above Node's 1 MiB default because a single run at a
 * high thinking level emits hundreds of streaming events and was measured at
 * ~1.02 MiB. On overflow `spawnSync` kills the child and returns truncated
 * output with no error text, which is indistinguishable from a model that
 * simply produced nothing.
 */
/**
 * Hash every file under a fixture root, keyed by forward-slash relative path.
 *
 * Recorded before and after each run so "only declared files changed" is a
 * checkable claim rather than an inference from whatever is left on disk.
 */
export function captureFixtureIdentity(fixtureDir) {
  const identity = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = relative_(fixtureDir, absolute).replaceAll("\\", "/");
      // Harness bookkeeping is not part of scenario fixture identity.
      if (relative === "tool-log.jsonl" || relative === "dispatch-registry.json") continue;
      // Nor is Git's own metadata, for scenarios given a fixture repository.
      // Every commit rewrites files under .git, which would drown the signal
      // this function exists to provide: which scenario files a role touched.
      if (relative === ".git" || relative.startsWith(".git/")) continue;
      identity[relative] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    }
  };
  if (existsSync(fixtureDir)) walk(fixtureDir);
  return identity;
}

/** Compare two fixture-identity snapshots. */
export function diffFixtureIdentity(before, after) {
  const added = Object.keys(after).filter((path) => !(path in before)).sort();
  const removed = Object.keys(before).filter((path) => !(path in after)).sort();
  const changed = Object.keys(after)
    .filter((path) => path in before && before[path] !== after[path])
    .sort();
  return {
    added,
    removed,
    changed,
    unauthorized(allowedMutations) {
      const allowed = new Set(allowedMutations ?? []);
      return [...added, ...removed, ...changed].filter((path) => !allowed.has(path)).sort();
    },
  };
}

export function spawnOptions() {
  return { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 };
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
  // A run that produced no final assistant text, or that never reached
  // agent_end, did not complete: the transport failed rather than the model
  // declining to answer. Either way it is not scoreable evidence.
  const truncated = !sawAgentEnd;
  if (assistantText.length === 0 || truncated) harnessBlocked = true;

  return {
    toolCalls,
    toolNames: toolCalls.map((call) => call.name),
    assistantText,
    finalText,
    provider,
    model,
    sawAgentEnd,
    truncated,
    status: harnessBlocked ? "HARNESS_BLOCKED" : "SCORED",
  };
}

/**
 * Pull the stored prompt bytes out of a dispatch-intent fixture.
 *
 * The fixture records them in a fenced block so the intent stays human-readable.
 * The closing fence's preceding newline terminates the block and is *not* part of
 * the stored bytes, but the newline ending the last content line is -- which is
 * exactly the byte seven runs dropped while reporting verbatim reuse.
 */
export function extractStoredPromptBytes(fixtureContent) {
  const match = /```\n([\s\S]*?)```/u.exec(fixtureContent);
  return match === null ? null : match[1];
}

export function scoreRun(scenario, inspection) {
  if (inspection.status === "HARNESS_BLOCKED") {
    return { status: "HARNESS_BLOCKED", expectedStateMatch: false, outputSchemaMatch: false };
  }

  const text = inspection.finalText;
  const reportedState = reportedStateOf(text);
  const expectedStateMatch = typeof scenario.expectedState === "string"
    ? reportedState === scenario.expectedState
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

  // A state token can underdetermine the reasoning that produced it: a controller
  // that dispatches without considering the store still lands on IMPLEMENT_RUNNING.
  // This lets a scenario name the discriminator it actually cares about instead of
  // leaving it in `expected_behavior`, which nothing enforces.
  const missingRequiredText = (scenario.requiredFinalText ?? [])
    .filter((needle) => !text.includes(needle));

  // Byte-compare the dispatched prompt against the bytes the fixture stored, when a
  // scenario declares that recovery must reissue rather than re-render. Seven of
  // fifteen runs in one family claimed "reissued verbatim" while silently dropping
  // the stored trailing newline, and every one scored GREEN because nothing checked.
  // On a path whose entire purpose is exactness, a claim is not evidence.
  const promptByteMismatches = [];
  if (typeof scenario.exactPromptFromFixture === "string") {
    const expectedPrompt = (scenario.fixtures ?? {})[scenario.exactPromptFromFixture];
    const spawned = inspection.toolCalls.find((call) => call.name === "spawn_subsession");
    const sent = spawned?.args?.prompt;
    if (typeof expectedPrompt !== "string") {
      promptByteMismatches.push(`fixture not found: ${scenario.exactPromptFromFixture}`);
    } else if (typeof sent !== "string") {
      promptByteMismatches.push("no spawn_subsession prompt to compare");
    } else {
      const stored = extractStoredPromptBytes(expectedPrompt);
      if (stored === null) {
        promptByteMismatches.push("fixture declares no fenced stored-prompt block");
      } else if (sent !== stored) {
        promptByteMismatches.push(
          `prompt bytes differ: sent ${JSON.stringify(sent)} stored ${JSON.stringify(stored)}`,
        );
      }
    }
  }

  return {
    status: "SCORED",
    expectedStateMatch,
    outputSchemaMatch: text.trim().length > 0,
    reportedState,
    missingRequiredText,
    promptByteMismatches,
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
  // Scenarios within one condition share an output directory, so this path
  // repeats. Clear it first: a stale report from an earlier scenario would make
  // the predeclared report path already exist, and the confined write tool
  // refuses to overwrite, failing the role on an artifact rather than its work.
  rmSync(invocation.fixtureDir, { recursive: true, force: true });
  mkdirSync(invocation.fixtureDir, { recursive: true });
  writeScenarioFixtures(args.scenario, invocation.fixtureDir);

  // Seed children that already exist, so a controller recovering from a crossed
  // spawn window can discover one with list_subsessions. The registry is keyed by
  // sessionId because the runtime returns only { sessionId, cwd } and offers no
  // dispatch key to look anything up by.
  const observed = args.scenario.seedObservedChildren;
  if (observed === undefined) return invocation.fixtureDir;

  const registry = {};
  for (const child of observed) {
    registry[child.sessionId] = {
      cwd: rewriteEvalTokens(child.cwd, invocation.fixtureDir),
      tier: child.tier ?? null,
      at: "2026-07-30T09:14:02.000Z",
    };
  }
  writeFileSync(
    join(invocation.fixtureDir, "dispatch-registry.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
  return invocation.fixtureDir;
}

function runRepetition(args, repetition) {
  const invocation = buildPiInvocation(args, repetition);
  const sourceProfile = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");

  prepareRepetitionWorkspace(args, invocation);
  const fixtureBefore = captureFixtureIdentity(invocation.fixtureDir);
  seedTemporaryProfile(invocation.profileDir, sourceProfile);

  const cleanup = () => { removeTemporaryProfile(invocation.profileDir); };
  const onSignal = () => { cleanup(); process.exit(130); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const result = spawnSync(invocation.command, invocation.args, {
      // A scenario that requires real Git inspection must run *inside* its
      // fixture repository. Otherwise git reports on the surrounding repo and an
      // honest role reports it could not verify its own change.
      cwd:
        args.scenario.fixtureGitRepository === true
          ? invocation.fixtureDir
          : args.evaluatorRoot,
      ...spawnOptions(),
      env: { ...process.env, ...invocation.env },
    });
    const inspection = inspectPiJsonEvents(String(result.stdout ?? ""));
    const score = scoreRun(args.scenario, inspection);
    const fixtureAfter = captureFixtureIdentity(invocation.fixtureDir);
    const fixtureDiff = diffFixtureIdentity(fixtureBefore, fixtureAfter);
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
      rolePromptSource: invocation.rolePromptSource,
      fixtureBefore,
      fixtureAfter,
      fixtureAdded: fixtureDiff.added,
      fixtureRemoved: fixtureDiff.removed,
      fixtureChanged: fixtureDiff.changed,
      unauthorizedMutations: fixtureDiff.unauthorized(args.scenario.allowedMutations),
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

  // Some scenarios require the role to inspect real Git state before reporting.
  // Without a repository, `git status` fails and an honest implementer must
  // report that it could not verify -- which makes the scenario's own
  // expectations mutually unsatisfiable. Initialize a committed repository so
  // the inspection the contract demands is actually possible.
  if (scenario.fixtureGitRepository === true) {
    const git = (...args) =>
      spawnSync("git", args, { cwd: fixtureDir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    git("init", "--quiet");
    git("config", "user.email", "sdd-eval@example.invalid");
    git("config", "user.name", "SDD Eval Fixture");
    git("config", "commit.gpgsign", "false");
    git("add", "--all");
    git("commit", "--quiet", "--message", "fixture baseline");
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
