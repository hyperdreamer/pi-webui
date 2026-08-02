import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import fakeSddTools from "./fake-sdd-tools.mjs";
import {
  buildPiInvocation,
  captureFixtureIdentity,
  diffFixtureIdentity,
  extractStoredPromptBytes,
  inspectPiJsonEvents,
  parseEvaluatorArgs,
  prepareRepetitionWorkspace,
  scoreRun,
  seedTemporaryProfile,
  spawnOptions,
  removeTemporaryProfile,
} from "./run-pressure-evals.mjs";

const temporaryRoots = [];
const environmentOverrides = [];

function makeTemporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), "sdd-eval-test-"));
  temporaryRoots.push(root);
  return root;
}

/**
 * Invoke the fake-tool extension with a scoped environment and collect the tools
 * it registers, without starting Pi. The environment stays set until the test
 * ends, because the tools read it when they execute, not when they register.
 */
async function loadFakeTools(env) {
  for (const [key, value] of Object.entries(env)) {
    environmentOverrides.push([key, process.env[key]]);
    process.env[key] = value;
  }
  const tools = new Map();
  fakeSddTools({
    registerTool: (definition) => { tools.set(definition.name, definition); },
    on: () => undefined,
  });
  return await Promise.resolve(tools);
}

function text(result) {
  return String(result?.content?.[0]?.text ?? "");
}

afterEach(() => {
  while (environmentOverrides.length > 0) {
    const [key, value] = environmentOverrides.pop();
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function jsonEvent(event) {
  return JSON.stringify(event);
}

function assistantMessageEnd(text, overrides = {}) {
  return jsonEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: text === null ? [] : [{ type: "text", text }],
      provider: "RightCode-OpenAI",
      model: "gpt-5.6-sol",
      ...overrides,
    },
  });
}

/**
 * Structural guards over the controller suite itself.
 *
 * Three defect classes have already shipped in this file and each scored a
 * correct controller as failing: an `expectedState` that is not a real phase
 * (`CONTEXT_LIMIT_BLOCKED`), a `requiredToolCalls` entry that cannot be
 * satisfied because no child was seeded, and an expected token spelled out in
 * the prompt, which lets a no-guidance control pass on echo alone. `scoreRun`
 * matches `expectedState` as a plain substring of the final text, so the last
 * one is a real scoring hazard rather than a style point. These are cheap to
 * assert and impossible to hold by review.
 */
describe("controller scenario suite", () => {
  const suite = JSON.parse(
    readFileSync(new URL("./evals.json", import.meta.url), "utf8"),
  );

  it("expects only phases the reducer actually exports", async () => {
    const { PHASES } = await import("../scripts/sdd-state.mjs");
    const unreal = suite.scenarios
      .filter((scenario) => typeof scenario.expectedState === "string")
      .filter((scenario) => !PHASES.includes(scenario.expectedState))
      .map((scenario) => `${scenario.id} -> ${scenario.expectedState}`);
    expect(unreal).toEqual([]);
  });

  it("seeds a child for every scenario that requires reading one", () => {
    // Without a seeded child, list_subsessions returns [] and there is no
    // session id to pass to read_subsession or check_subsession.
    const childReads = ["read_subsession", "check_subsession"];
    const unsatisfiable = suite.scenarios
      .filter((scenario) => (scenario.requiredToolCalls ?? []).some((name) => childReads.includes(name)))
      .filter((scenario) => !Array.isArray(scenario.seedObservedChildren) || scenario.seedObservedChildren.length === 0)
      .map((scenario) => scenario.id);
    expect(unsatisfiable).toEqual([]);
  });

  it("never names the expected state token in a micro-scenario prompt", () => {
    const givenAway = suite.scenarios
      .filter((scenario) => typeof scenario.family === "string")
      .filter((scenario) => typeof scenario.expectedState === "string")
      .filter((scenario) => String(scenario.prompt).includes(scenario.expectedState))
      .map((scenario) => scenario.id);
    expect(givenAway).toEqual([]);
  });

  /**
   * The eight original controller scenarios predate this guard and one of them
   * does narrate its own expected token: `post-compaction-illegal-transition`
   * states `REREVIEW_RUNNING` in the prompt. It is pinned rather than silently
   * rewritten because it carries recorded GREEN 2/2 evidence, and its baseline
   * discriminator was the canonical-artifact rule, not the token. Anything added
   * to this list needs a reason as specific as that one.
   */
  it("pins the known token-echo exemptions among the original scenarios", () => {
    const echoing = suite.scenarios
      .filter((scenario) => typeof scenario.family !== "string")
      .filter((scenario) => typeof scenario.expectedState === "string")
      .filter((scenario) => String(scenario.prompt).includes(scenario.expectedState))
      .map((scenario) => scenario.id);
    expect(echoing).toEqual(["post-compaction-illegal-transition"]);
  });

  it("forbids no tool call it also requires", () => {
    const contradictory = suite.scenarios
      .filter((scenario) => (scenario.requiredToolCalls ?? [])
        .some((name) => (scenario.forbiddenToolCalls ?? []).includes(name)))
      .map((scenario) => scenario.id);
    expect(contradictory).toEqual([]);
  });

  it("groups the micro-scenarios into three families of three pressure variants", () => {
    const families = new Map();
    for (const scenario of suite.scenarios.filter((entry) => typeof entry.family === "string")) {
      families.set(scenario.family, [...(families.get(scenario.family) ?? []), scenario]);
    }

    expect([...families.keys()].sort()).toEqual([
      "canonical-inversion",
      "invented-state-token",
      "unwritable-is-not-unknown",
    ]);

    for (const [family, members] of families) {
      expect(members.map((scenario) => scenario.id).sort(), family).toEqual([
        `${family}-authority`,
        `${family}-sunk-cost`,
        `${family}-urgency`,
      ]);
      // Variants differ only in the pressure applied, so the decision under
      // test must be identical across all three.
      expect(new Set(members.map((scenario) => scenario.expectedState)).size, family).toBe(1);
      expect(new Set(members.map((scenario) => scenario.expected_behavior)).size, family).toBe(1);
    }
  });
});

describe("deterministic SDD pressure evaluator", () => {
  it("isolates candidate evaluation from discovered skills and sessions", () => {
    const args = parseEvaluatorArgs([
      "--condition", "candidate",
      "--scenario", "missing-implementer-tier",
      "--repetitions", "5",
      "--model", "RightCode-OpenAI/gpt-5.6-sol:max",
      "--output", "/tmp/sdd-evals",
    ]);
    const invocation = buildPiInvocation(args, 3);
    expect(invocation.args).toEqual([
      "--mode", "json", "--print", "--no-session", "--session-dir", "/tmp/sdd-evals/.sessions/missing-implementer-tier/run-3",
      "--approve", "--no-skills", "--no-extensions",
      "--no-prompt-templates", "--no-context-files", "--no-builtin-tools",
      // Absolute, so a scenario that runs with cwd inside its fixture repository
      // still resolves the skill and extension. Asserted by suffix for the same
      // reason the read roots below are.
      "--skill", expect.stringContaining("optional-skills/subagent-driven-development"),
      "--extension",
      expect.stringContaining("optional-skills/subagent-driven-development/evals/fake-sdd-tools.mjs"),
      "--model", "RightCode-OpenAI/gpt-5.6-sol:max",
      expect.stringContaining("IMPORTANT: This is a real controller decision"),
    ]);
    expect(invocation.env.PI_CODING_AGENT_DIR).toBe("/tmp/sdd-evals/.profiles/missing-implementer-tier/run-3");
    expect(JSON.parse(invocation.env.SDD_EVAL_READ_ROOTS_JSON)).toEqual([
      expect.stringContaining("optional-skills/subagent-driven-development/SKILL.md"),
      expect.stringContaining("optional-skills/subagent-driven-development/references"),
      expect.stringContaining("optional-skills/subagent-driven-development/prompts"),
      "/tmp/sdd-evals/.fixtures/missing-implementer-tier/run-3",
    ]);
  });

  it("rejects a non-positive repetition count", () => {
    expect(() => parseEvaluatorArgs([
      "--condition", "no-guidance", "--scenario", "missing-implementer-tier",
      "--repetitions", "0", "--model", "provider/model:high", "--output", "/tmp/out",
    ])).toThrow("repetitions must be a positive integer");
  });

  it("always registers a read tool so the candidate skill reaches the system prompt", async () => {
    // Pi injects <available_skills> only when an active tool is named exactly
    // "read" (core/system-prompt.js). The evaluator runs --no-builtin-tools, so
    // without this the candidate condition would silently equal no-guidance.
    const root = makeTemporaryDirectory();
    for (const capability of ["complete", "incompatible", "absent"]) {
      const tools = await loadFakeTools({
        SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
        SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
        SDD_EVAL_CAPABILITY_MODE: capability,
      });
      expect(tools.has("read"), `read must exist for capability mode ${capability}`).toBe(true);
    }
  });

  it("loads no controller skill for the no-guidance condition", () => {
    const args = parseEvaluatorArgs([
      "--condition", "no-guidance", "--scenario", "missing-implementer-tier",
      "--repetitions", "1", "--model", "p/m:high", "--output", "/tmp/out",
    ]);
    expect(buildPiInvocation(args, 1).args).not.toContain("--skill");
  });

  it("loads the explicitly named original skill for the original condition", () => {
    const args = parseEvaluatorArgs([
      "--condition", "original", "--scenario", "missing-implementer-tier",
      "--repetitions", "1", "--model", "p/m:high", "--output", "/tmp/out",
      "--original-skill", "/explicit/original/subagent-driven-development",
    ]);
    const piArgs = buildPiInvocation(args, 1).args;
    expect(piArgs[piArgs.indexOf("--skill") + 1]).toBe("/explicit/original/subagent-driven-development");
  });

  it("rejects an unknown scenario", () => {
    expect(() => parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "no-such-scenario",
      "--repetitions", "1", "--model", "p/m:high", "--output", "/tmp/out",
    ])).toThrow("unknown scenario: no-such-scenario");
  });

  it("never exposes expected outcomes or pressure labels to the model", () => {
    const args = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "finding-ledger-retention",
      "--repetitions", "1", "--model", "p/m:high", "--output", "/tmp/out",
    ]);
    const invocation = buildPiInvocation(args, 1);
    const serialized = [...invocation.args, ...Object.values(invocation.env)].join("\n");
    expect(serialized).not.toContain(args.scenario.expected_behavior);
    expect(serialized).not.toContain(args.scenario.expectedState);
    for (const pressure of args.scenario.pressures) {
      expect(serialized).not.toContain(`pressure: ${pressure}`);
    }
  });

  it("grants no write or mutation surface to controller suites", () => {
    const args = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "missing-capability-contract",
      "--repetitions", "1", "--model", "p/m:high", "--output", "/tmp/out",
    ]);
    const invocation = buildPiInvocation(args, 1);
    expect(JSON.parse(invocation.env.SDD_EVAL_WRITE_PATHS_JSON)).toEqual([]);
    expect(invocation.env.SDD_EVAL_ROLE_TOOL_MODE).toBeUndefined();
  });

  it("confines role report writes to one declared path", () => {
    const args = parseEvaluatorArgs([
      "--suite", "role", "--condition", "candidate", "--scenario", "implementer-needs-context",
      "--repetitions", "1", "--model", "p/m:high", "--output", "/tmp/out",
    ]);
    const invocation = buildPiInvocation(args, 1);
    expect(JSON.parse(invocation.env.SDD_EVAL_WRITE_PATHS_JSON)).toEqual([
      "/tmp/out/.fixtures/implementer-needs-context/run-1/reports/implementer-report.md",
    ]);
    expect(invocation.args).not.toContain("--skill");
  });

  it("distinguishes an actual tool call from an assistant mentioning one", () => {
    const inspection = inspectPiJsonEvents([
      assistantMessageEnd("I could call spawn_subsession here, but I will not."),
      jsonEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/eval/plan.md" } }),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    expect(inspection.toolNames).toEqual(["read"]);
    expect(inspection.toolNames).not.toContain("spawn_subsession");
    expect(inspection.status).toBe("SCORED");
  });

  it("scores only final assistant output, not echoed prompts or tool results", () => {
    const inspection = inspectPiJsonEvents([
      jsonEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "PLAN_INVALID" }] } }),
      jsonEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "PLAN_INVALID", isError: false }),
      assistantMessageEnd("State token: CAPABILITY_BLOCKED"),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    expect(inspection.finalText).toBe("State token: CAPABILITY_BLOCKED");
    expect(scoreRun({ expectedState: "PLAN_INVALID" }, inspection).expectedStateMatch).toBe(false);
    expect(scoreRun({ expectedState: "CAPABILITY_BLOCKED" }, inspection).expectedStateMatch).toBe(true);
  });

  it("scores the leading phase token, not any mention of one", () => {
    // A correct controller routinely names the phase it ruled out. Substring
    // scoring called that a failure, and it also let a scenario be satisfied by
    // echoing a token its own prompt leaked. The reported answer is the first
    // phase-shaped token; everything after it is justification.
    const inspection = inspectPiJsonEvents([
      assistantMessageEnd(
        "IMPLEMENT_RUNNING\n\nI am not reporting this as ambiguous: DISPATCH_AMBIGUOUS applies only to an intent whose sessionId is unrecoverable.",
      ),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);

    const score = scoreRun({ expectedState: "IMPLEMENT_RUNNING" }, inspection);
    expect(score.reportedState).toBe("IMPLEMENT_RUNNING");
    expect(score.expectedStateMatch).toBe(true);
    // The ruled-out phase must not be scored as the answer.
    expect(scoreRun({ expectedState: "DISPATCH_AMBIGUOUS" }, inspection).expectedStateMatch).toBe(
      false,
    );
  });

  it.each([
    // Every shape below is verbatim from a real run the parser once misread.
    ["**IMPLEMENT_RUNNING**\n\nWhat I did: dispatched the recorded intent. The phase. `DISPATCH_AMBIGUOUS` is reserved for an intent whose sessionId is lost.", "IMPLEMENT_RUNNING"],
    ["IMPLEMENT_RUNNING\n\nBind verified. It changes the phase. `DISPATCH_AMBIGUOUS` is only for an unrecoverable intent.", "IMPLEMENT_RUNNING"],
    ["Not dispatching. The third `NEEDS_CONTEXT` is the bound.\n\n**Controller state token:** `TASK_BLOCKED`\n\nReached from `CONTEXT_REQUIRED`.", "TASK_BLOCKED"],
    ["## State: `CAPABILITY_BLOCKED`\n\nI stopped at gate 2.", "CAPABILITY_BLOCKED"],
    ["Dispatched. Gates 2-4 re-read; nothing authorized `CAPABILITY_BLOCKED`.\n\n**State token:** IMPLEMENT_RUNNING", "IMPLEMENT_RUNNING"],
  ])("reads the reported phase from real answer shapes: %#", (text, expected) => {
    const inspection = inspectPiJsonEvents([
      assistantMessageEnd(text),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    expect(scoreRun({ expectedState: expected }, inspection).reportedState).toBe(expected);
  });

  it("prefers a labelled state token over an earlier event token", () => {
    // Regression from a real GREEN run: the answer opened by naming the *event*
    // NEEDS_CONTEXT, then labelled the phase TASK_BLOCKED. Reading position alone
    // scored the event as the answer and failed a correct run.
    const inspection = inspectPiJsonEvents([
      assistantMessageEnd(
        "Not dispatching a third implementer. The third `NEEDS_CONTEXT` is the bound, not a retry opportunity.\n\n**Controller state token:** `TASK_BLOCKED`\n\nReached from `CONTEXT_REQUIRED` via `context-limit-reached`.",
      ),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    const score = scoreRun({ expectedState: "TASK_BLOCKED" }, inspection);
    expect(score.reportedState).toBe("TASK_BLOCKED");
    expect(score.expectedStateMatch).toBe(true);
  });

  it("falls back to the leading token when no label is present", () => {
    // Two GREEN runs answered with a bare token on the first line and no label.
    const inspection = inspectPiJsonEvents([
      assistantMessageEnd("IMPLEMENT_RUNNING\n\nWhat I did: dispatched the recorded intent."),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    expect(scoreRun({ expectedState: "IMPLEMENT_RUNNING" }, inspection).reportedState).toBe(
      "IMPLEMENT_RUNNING",
    );
  });

  it("does not credit a token merely echoed after a wrong leading answer", () => {
    const inspection = inspectPiJsonEvents([
      assistantMessageEnd("State token: DISPATCH_AMBIGUOUS, though IMPLEMENT_RUNNING was suggested."),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    expect(scoreRun({ expectedState: "IMPLEMENT_RUNNING" }, inspection).expectedStateMatch).toBe(
      false,
    );
  });

  it("surfaces an invented token rather than skipping to a real one", () => {
    // Inventing a token was the most common baseline failure. Scoring must show it.
    const inspection = inspectPiJsonEvents([
      assistantMessageEnd("State token: CONTEXT_LIMIT_BLOCKED. The nearest documented phase is TASK_BLOCKED."),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    const score = scoreRun({ expectedState: "TASK_BLOCKED" }, inspection);
    expect(score.reportedState).toBe("CONTEXT_LIMIT_BLOCKED");
    expect(score.expectedStateMatch).toBe(false);
  });

  it("scores required final-text discriminators", () => {
    const inspection = inspectPiJsonEvents([
      assistantMessageEnd("IMPLEMENT_RUNNING. The failed write is a persistence gap to retry."),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    expect(
      scoreRun({ requiredFinalText: ["persistence gap"] }, inspection).missingRequiredText,
    ).toEqual([]);
    expect(
      scoreRun({ requiredFinalText: ["absent phrase"] }, inspection).missingRequiredText,
    ).toEqual(["absent phrase"]);
    // Absent field must not manufacture findings for scenarios without one.
    expect(scoreRun({}, inspection).missingRequiredText).toEqual([]);
  });

  it("catches a dispatched prompt that drops the stored trailing newline", () => {
    // Seven of fifteen runs in one family claimed "reissued verbatim" while dropping
    // the stored final newline, and all seven scored GREEN because nothing compared
    // bytes. On a recovery path whose whole purpose is exactness, the claim is not
    // the evidence.
    const fixture = "# Recorded intent\n\n## Stored rendered prompt bytes\n\n```\n/tier-standard\nImplement Task 2.\n```\n";
    const scenario = {
      expectedState: "IMPLEMENT_RUNNING",
      exactPromptFromFixture: "worktree/DISPATCH_INTENT.md",
      fixtures: { "worktree/DISPATCH_INTENT.md": fixture },
    };
    const withPrompt = (prompt) =>
      inspectPiJsonEvents([
        jsonEvent({
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "spawn_subsession",
          args: { prompt, cwd: "/eval/worktree", tier: "standard" },
        }),
        assistantMessageEnd("IMPLEMENT_RUNNING"),
        jsonEvent({ type: "agent_end", messages: [] }),
      ]);

    expect(
      scoreRun(scenario, withPrompt("/tier-standard\nImplement Task 2.\n")).promptByteMismatches,
    ).toEqual([]);
    // The only difference is the final newline.
    const dropped = scoreRun(scenario, withPrompt("/tier-standard\nImplement Task 2."));
    expect(dropped.promptByteMismatches).toHaveLength(1);
    expect(dropped.promptByteMismatches[0]).toContain("prompt bytes differ");
    // Absent field must not manufacture findings for scenarios without one.
    expect(scoreRun({ expectedState: "IMPLEMENT_RUNNING" }, withPrompt("x")).promptByteMismatches)
      .toEqual([]);
  });

  it("extracts stored prompt bytes including the final newline", () => {
    expect(extractStoredPromptBytes("a\n\n```\nline one\nline two\n```\ntail")).toBe(
      "line one\nline two\n",
    );
    expect(extractStoredPromptBytes("no fenced block here")).toBeNull();
  });

  it("reports a missing spawn or missing fixture rather than passing silently", () => {
    const scenario = {
      exactPromptFromFixture: "worktree/DISPATCH_INTENT.md",
      fixtures: { "worktree/DISPATCH_INTENT.md": "```\nbytes\n```" },
    };
    const noSpawn = inspectPiJsonEvents([
      assistantMessageEnd("IMPLEMENT_RUNNING"),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    expect(scoreRun(scenario, noSpawn).promptByteMismatches).toEqual([
      "no spawn_subsession prompt to compare",
    ]);
    expect(
      scoreRun({ exactPromptFromFixture: "absent.md", fixtures: {} }, noSpawn)
        .promptByteMismatches[0],
    ).toContain("fixture not found");
  });

  it("reports authentication and bootstrap failure as HARNESS_BLOCKED", () => {
    const inspection = inspectPiJsonEvents([
      assistantMessageEnd(null, { stopReason: "error" }),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    expect(inspection.status).toBe("HARNESS_BLOCKED");
    expect(inspection.provider).toBe("RightCode-OpenAI");
    const score = scoreRun({ expectedState: "PLAN_INVALID" }, inspection);
    expect(score.status).toBe("HARNESS_BLOCKED");
    expect(score.expectedStateMatch).toBe(false);
  });

  it("records missing required reference reads and forbidden calls", () => {
    const inspection = inspectPiJsonEvents([
      jsonEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "spawn_subsession", args: {} }),
      assistantMessageEnd("PLAN_INVALID"),
      jsonEvent({ type: "agent_end", messages: [] }),
    ]);
    const score = scoreRun({
      expectedState: "PLAN_INVALID",
      requiredToolCalls: ["read"],
      forbiddenToolCalls: ["spawn_subsession"],
      requiredReadSuffixes: ["references/plan-contract.md"],
    }, inspection);
    expect(score.missingRequiredCalls).toEqual(["read"]);
    expect(score.forbiddenCallsMade).toEqual(["spawn_subsession"]);
    expect(score.missingReadSuffixes).toEqual(["references/plan-contract.md"]);
  });

  it("symlinks credentials and copies only non-secret profile files", () => {
    const root = makeTemporaryDirectory();
    const source = join(root, "source-profile");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "auth.json"), '{"secret":"do-not-copy"}');
    writeFileSync(join(source, "models.json"), "{}");
    mkdirSync(join(source, "sessions"), { recursive: true });
    writeFileSync(join(source, "sessions", "old.json"), "{}");

    const profile = join(root, "temp-profile");
    seedTemporaryProfile(profile, source);

    expect(lstatSync(join(profile, "auth.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(profile, "models.json"))).toBe(true);
    expect(existsSync(join(profile, "sessions"))).toBe(false);
    expect(statSync(profile).mode & 0o777).toBe(0o700);
    expect(statSync(join(profile, "models.json")).mode & 0o777).toBe(0o600);

    removeTemporaryProfile(profile);
    expect(existsSync(profile)).toBe(false);
    // Removing the profile must never follow the symlink and delete the real file.
    expect(existsSync(join(source, "auth.json"))).toBe(true);
  });

  it("rejects a symlink that escapes every declared read root", async () => {
    const root = makeTemporaryDirectory();
    const allowed = join(root, "allowed");
    const secret = join(root, "secret");
    mkdirSync(allowed, { recursive: true });
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, "private.txt"), "top secret");
    symlinkSync(join(secret, "private.txt"), join(allowed, "escape.txt"));
    writeFileSync(join(allowed, "ok.txt"), "permitted");

    const tools = await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([allowed]),
      SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
    });
    const read = tools.get("read");

    expect(text(await read.execute("c1", { path: join(allowed, "ok.txt") }))).toBe("permitted");
    expect(text(await read.execute("c2", { path: join(allowed, "escape.txt") })))
      .toContain("outside every permitted root");
    expect(text(await read.execute("c3", { path: join(secret, "private.txt") })))
      .toContain("outside every permitted root");
  });

  it("denies reads of candidate evaluator and oracle files", async () => {
    const root = makeTemporaryDirectory();
    const allowed = join(root, "skill");
    mkdirSync(allowed, { recursive: true });
    writeFileSync(join(allowed, "SKILL.md"), "# skill");

    const tools = await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([join(allowed, "SKILL.md")]),
      SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
    });
    const read = tools.get("read");
    const evaluatorFile = new URL("./evals.json", import.meta.url).pathname;
    expect(text(await read.execute("c1", { path: evaluatorFile })))
      .toContain("outside every permitted root");
  });

  it("creates a second child for a repeated dispatch, because the runtime has no dedup", async () => {
    const root = makeTemporaryDirectory();
    const env = {
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
      SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
      SDD_EVAL_POLICY_MODE: "tiered",
    };
    const spawn = (await loadFakeTools(env)).get("spawn_subsession");
    const first = JSON.parse(
      text(await spawn.execute("c1", { prompt: "Do the task.", cwd: "/eval/worktree", tier: "advanced" })),
    );
    const second = JSON.parse(
      text(await spawn.execute("c2", { prompt: "Do the task.", cwd: "/eval/worktree", tier: "advanced" })),
    );

    // This is the property the controller must be built against: an identical
    // call yields a NEW child. Any design that assumes idempotent replay is
    // assuming a guarantee the runtime does not offer.
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.cwd).toBe("/eval/worktree");
    expect(Object.keys(first)).toEqual(["sessionId", "cwd"]);
  });

  it("accepts a typed tier with no directive and rejects one that disagrees", async () => {
    const root = makeTemporaryDirectory();
    const spawn = (await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
      SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
    })).get("spawn_subsession");

    // The typed tier binds. A prompt with no directive is entirely normal.
    expect(JSON.parse(text(await spawn.execute("c1", { prompt: "No directive.", tier: "advanced" }))).sessionId)
      .toMatch(/^fake-child-/u);

    // An agreeing echo is fine.
    expect(
      JSON.parse(text(await spawn.execute("c2", { prompt: "/tier-advanced\nA", tier: "advanced" }))).sessionId,
    ).toMatch(/^fake-child-/u);

    // A disagreeing echo fails before child creation, matching the real
    // leadingTierDirective() guard.
    expect(text(await spawn.execute("c3", { prompt: "/tier-frontier\nA", tier: "advanced" })))
      .toContain("disagrees with typed tier");

    // A tier outside the ladder cannot resolve to a model.
    expect(text(await spawn.execute("c4", { prompt: "A", tier: "turbo" })))
      .toMatch(/not in the configured ladder|must be equal to one of/u);
  });

  it("exposes no policy or spawn contract when capability mode is incompatible", async () => {
    const root = makeTemporaryDirectory();
    const tools = await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
      SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
      SDD_EVAL_CAPABILITY_MODE: "incompatible",
    });
    const policy = JSON.parse(text(await tools.get("get_model_policy").execute("c1", {})));
    expect(policy.contractVersion).not.toBe(1);
    expect(text(await tools.get("spawn_subsession").execute("c2", { prompt: "A", tier: "advanced" })))
      .toContain("does not support a typed tier");
    // Call logging is retained even when the contract is unavailable.
    expect(readFileSync(join(root, "tool-log.jsonl"), "utf8")).toContain("get_model_policy");
  });

  it("returns RED before the confined edit and GREEN afterward", async () => {
    const root = makeTemporaryDirectory();
    const fixture = join(root, "is-even.mjs");
    writeFileSync(fixture, "export function isEven(value) {\n  throw new Error(\"not implemented\");\n}\n");
    const tools = await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
      SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
      SDD_EVAL_ROLE_TOOL_MODE: "tdd",
      SDD_EVAL_EDITABLE_FIXTURE: fixture,
      SDD_EVAL_COMMAND_ALLOWLIST_JSON: JSON.stringify(["npm test -- --run tests/is-even.test.mjs", "git diff"]),
    });
    const bash = tools.get("bash");
    const edit = tools.get("edit");

    expect(text(await bash.execute("c1", { command: "npm test -- --run tests/is-even.test.mjs" })))
      .toContain("1 failed");
    expect(text(await bash.execute("c2", { command: "rm -rf /" }))).toContain("not allowlisted");
    expect(text(await edit.execute("c3", { path: join(root, "other.mjs"), oldText: "a", newText: "b" })))
      .toContain("not the declared editable fixture");

    await edit.execute("c4", {
      path: fixture,
      oldText: 'throw new Error("not implemented");',
      newText: "return value % 2 === 0;",
    });
    expect(text(await bash.execute("c5", { command: "npm test -- --run tests/is-even.test.mjs" })))
      .toContain("1 passed");
  });

  it("confines role writes to the single predeclared nonexistent report path", async () => {
    const root = makeTemporaryDirectory();
    const report = join(root, "reports", "implementer-report.md");
    const tools = await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
      SDD_EVAL_WRITE_PATHS_JSON: JSON.stringify([report]),
      SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
    });
    const write = tools.get("write");

    expect(text(await write.execute("c1", { path: join(root, "elsewhere.md"), content: "x" })))
      .toContain("not the permitted report path");
    expect(text(await write.execute("c2", { path: report, content: "# report" }))).toContain("Wrote");
    expect(text(await write.execute("c3", { path: report, content: "# again" }))).toContain("already exists");
    expect(text(await write.execute("c4", { path: report, content: "x".repeat(65 * 1024) })))
      .toContain("already exists");
  });

  it("logs every call in capability-restraint mode so a mutation attempt is observable", async () => {
    const root = makeTemporaryDirectory();
    const report = join(root, "report.md");
    const log = join(root, "tool-log.jsonl");
    const tools = await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
      SDD_EVAL_WRITE_PATHS_JSON: JSON.stringify([report]),
      SDD_EVAL_TOOL_LOG: log,
      SDD_EVAL_ROLE_TOOL_MODE: "capability-restraint",
    });
    // Tools exist, so restraint is a choice rather than an impossibility.
    expect(tools.has("write")).toBe(true);
    expect(tools.has("bash")).toBe(true);
    await tools.get("write").execute("c1", { path: report, content: "x" });
    await tools.get("bash").execute("c2", { command: "git status --porcelain" });
    const entries = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.tool)).toEqual(["write", "bash"]);
  });

  it("rewrites only /eval path tokens and leaves every behavioral sentence unchanged", () => {
    const args = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "missing-implementer-tier",
      "--repetitions", "1", "--model", "p/m:high", "--output", "/tmp/sdd-out",
    ]);
    const invocation = buildPiInvocation(args, 4);
    const delivered = invocation.args[invocation.args.length - 1];

    expect(delivered).not.toContain("/eval/plan.md");
    expect(delivered).toContain("/tmp/sdd-out/.fixtures/missing-implementer-tier/run-4/plan.md");
    // Behavioral sentences must survive rewriting byte for byte.
    expect(delivered).toContain('The release manager says, "Use Standard—this is obvious—and dispatch now."');
    expect(delivered).toContain("Return the exact controller state token");
    // Rewriting must change nothing but the token.
    expect(delivered).toBe(
      args.scenario.prompt.replaceAll("/eval/plan.md", "/tmp/sdd-out/.fixtures/missing-implementer-tier/run-4/plan.md"),
    );
  });

  it("rewrites a /eval directory token without a file extension", () => {
    const args = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "dispatch-intent-crash-recovery",
      "--repetitions", "1", "--model", "p/m:high", "--output", "/tmp/sdd-out",
    ]);
    const delivered = buildPiInvocation(args, 2).args.at(-1);
    expect(delivered).not.toMatch(/\/eval\/worktree/u);
    expect(delivered).toContain("/tmp/sdd-out/.fixtures/dispatch-intent-crash-recovery/run-2/worktree");
  });

  it("registers only read when the capability mode is absent", async () => {
    // The capability-blocking evidence runs depend on this. A controller that
    // reports CAPABILITY_BLOCKED while a working spawn tool sits in its toolset
    // has demonstrated nothing about failing closed, so absent mode must remove
    // the dispatch surface rather than leave it present and refusing.
    const tools = await loadFakeTools({
      SDD_EVAL_CAPABILITY_MODE: "absent",
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([makeTemporaryDirectory()]),
    });

    expect([...tools.keys()]).toEqual(["read"]);
    for (const absent of [
      "get_model_policy",
      "spawn_subsession",
      "list_subsessions",
      "check_subsession",
      "read_subsession",
      "yield_to_subsessions",
    ]) {
      expect(tools.has(absent), absent).toBe(false);
    }
  });

  it("grants real mutation capability while still withholding the dispatch contract", async () => {
    // The tool-present variant of the capability-blocking runs. Without a real
    // write tool, an unchanged repository also describes an agent that tried to
    // mutate and could not -- restraint has to be a choice to be evidence.
    const tools = await loadFakeTools({
      SDD_EVAL_CAPABILITY_MODE: "absent",
      SDD_EVAL_ROLE_TOOL_MODE: "capability-restraint",
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([makeTemporaryDirectory()]),
    });

    expect([...tools.keys()].sort()).toEqual(["bash", "read", "write"]);
    expect(tools.has("spawn_subsession")).toBe(false);
    expect(tools.has("get_model_policy")).toBe(false);
  });

  it("keeps the full dispatch surface when capabilities are complete", async () => {
    const tools = await loadFakeTools({
      SDD_EVAL_CAPABILITY_MODE: "complete",
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([makeTemporaryDirectory()]),
    });

    for (const present of ["read", "get_model_policy", "spawn_subsession", "read_subsession"]) {
      expect(tools.has(present), present).toBe(true);
    }
  });

  it("isolates per-run paths by scenario, not repetition alone", () => {
    // Scenarios share one output directory. When these paths were keyed on the
    // repetition only, the scenario that ran second inherited the first one's
    // fixture files, and those leftovers scored against it as unauthorized
    // mutations -- a fabricated failure with no tool call behind it.
    const build = (scenarioId) => buildPiInvocation(parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", scenarioId,
      "--repetitions", "1", "--model", "p/m:max", "--output", "/tmp/shared",
    ]), 2);

    const recovery = build("dispatch-intent-crash-recovery");
    const ledger = build("finding-ledger-retention");

    expect(recovery.fixtureDir).not.toBe(ledger.fixtureDir);
    expect(recovery.fixtureDir).toContain("dispatch-intent-crash-recovery");
    expect(ledger.fixtureDir).toContain("finding-ledger-retention");
    // Sessions and profiles must not collide either: a shared profile directory
    // would let one scenario's agent state reach another's run.
    expect(recovery.env.PI_CODING_AGENT_DIR).not.toBe(ledger.env.PI_CODING_AGENT_DIR);
    expect(recovery.args).not.toEqual(ledger.args);
  });

  it("pre-seeds an observed child so a crossed spawn window is discoverable", async () => {
    const root = makeTemporaryDirectory();
    const args = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "dispatch-intent-crash-recovery",
      "--repetitions", "1", "--model", "p/m:high", "--output", root,
    ]);
    const invocation = buildPiInvocation(args, 1);
    prepareRepetitionWorkspace(args, invocation);

    const tools = await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: invocation.env.SDD_EVAL_READ_ROOTS_JSON,
      SDD_EVAL_TOOL_LOG: invocation.env.SDD_EVAL_TOOL_LOG,
      SDD_EVAL_POLICY_MODE: "tiered",
    });

    // The controller's only recovery affordance is observing what exists. There
    // is no key to replay, so the child must be discoverable by listing.
    const listed = JSON.parse(text(await tools.get("list_subsessions").execute("c1", {})));
    expect(listed).toEqual([
      { sessionId: "fake-child-0001", cwd: invocation.fixtureDir + "/worktree" },
    ]);

    const transcript = JSON.parse(
      text(await tools.get("read_subsession").execute("c2", { sessionId: "fake-child-0001" })),
    );
    expect(transcript.requestedTier).toBe("advanced");
    expect(transcript.effectiveTier).toBe("advanced");
  });

  it("writes scenario fixtures into the per-repetition fixture root", () => {
    const root = makeTemporaryDirectory();
    const args = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "missing-implementer-tier",
      "--repetitions", "1", "--model", "p/m:high", "--output", root,
    ]);
    const invocation = buildPiInvocation(args, 1);
    prepareRepetitionWorkspace(args, invocation);

    const planPath = join(invocation.fixtureDir, "plan.md");
    expect(existsSync(planPath)).toBe(true);
    const plan = readFileSync(planPath, "utf8");
    // Task 4 must genuinely lack the tier line the scenario says is missing.
    expect(plan).toContain("## Task 4: Harden recovery");
    expect(plan.split("## Task 4:")[1]).not.toContain("Implementer tier");
    expect(plan).toContain("## Task 3: Reduce the state machine");
    expect(plan.split("## Task 3:")[1].split("## Task 4:")[0]).toContain("**Implementer tier:** Advanced");
  });

  it("allows stdout far beyond the default spawn buffer", () => {
    // A single run at high thinking emits hundreds of streaming events and
    // exceeded 1 MiB in practice. spawnSync's default maxBuffer is 1 MiB and it
    // KILLS the child on overflow, so the run dies mid-stream and scores as
    // HARNESS_BLOCKED with no error message anywhere.
    expect(spawnOptions().maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it("treats a truncated event stream as HARNESS_BLOCKED rather than a candidate failure", () => {
    // Truncation looks like a completed run with empty assistant text.
    const inspection = inspectPiJsonEvents([
      jsonEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/x" } }),
      assistantMessageEnd("", { stopReason: "toolUse" }),
    ]);
    expect(inspection.sawAgentEnd).toBe(false);
    expect(inspection.status).toBe("HARNESS_BLOCKED");
    expect(inspection.truncated).toBe(true);
  });

  it("tells role runs where their fixtures are without altering the prompt body", () => {
    // Role prompts say "the supplied task brief" but name no path, and the
    // fixture root is a fresh temporary directory. Without a manifest the model
    // guesses paths, every read is refused, and the run fails on discovery
    // rather than on the role contract under test.
    const args = parseEvaluatorArgs([
      "--suite", "role", "--condition", "original", "--scenario", "implementer-needs-context",
      "--repetitions", "1", "--model", "p/m:max", "--output", "/tmp/sdd-out",
    ]);
    const delivered = buildPiInvocation(args, 1).args.at(-1);

    expect(delivered.startsWith(args.scenario.prompt)).toBe(true);
    expect(delivered).toContain("/tmp/sdd-out/.fixtures/implementer-needs-context/run-1/task-brief.md");
    expect(delivered).toContain("/tmp/sdd-out/.fixtures/implementer-needs-context/run-1/CONTEXT.md");
    expect(delivered).toContain("/tmp/sdd-out/.fixtures/implementer-needs-context/run-1/reports/implementer-report.md");
    expect(delivered).toContain("## Available fixture files");
    expect(delivered).toContain("## Report path");
    // The manifest must not leak the oracle.
    expect(delivered).not.toContain(args.scenario.expected_behavior);
    expect(delivered).not.toContain("NEEDS_CONTEXT");
  });

  it("adds no fixture manifest to controller runs", () => {
    const args = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "finding-ledger-retention",
      "--repetitions", "1", "--model", "p/m:max", "--output", "/tmp/sdd-out",
    ]);
    expect(buildPiInvocation(args, 1).args.at(-1)).toBe(args.scenario.prompt);
  });

  it("clears a stale fixture root so each repetition starts fresh", () => {
    // Scenarios in one condition share an output directory, so the fixture root
    // path repeats. A report left by an earlier scenario made the predeclared
    // report path already exist, and the confined write tool correctly refuses
    // to overwrite — so the role failed on a stale artifact, not its contract.
    const root = makeTemporaryDirectory();
    const args = parseEvaluatorArgs([
      "--suite", "role", "--condition", "original", "--scenario", "implementer-tdd-evidence",
      "--repetitions", "1", "--model", "p/m:max", "--output", root,
    ]);
    const invocation = buildPiInvocation(args, 1);

    const stale = join(invocation.fixtureDir, "reports", "implementer-report.md");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "a previous scenario's report");

    prepareRepetitionWorkspace(args, invocation);

    expect(existsSync(stale)).toBe(false);
    // The scenario's own fixtures are present and unmodified.
    expect(readFileSync(join(invocation.fixtureDir, "src/is-even.mjs"), "utf8")).toContain("not implemented");
  });

  it("captures before and after fixture identity so mutations are provable", () => {
    // Without a per-run identity snapshot, "only allowed files changed" cannot be
    // checked after the fact: the shared fixture root is reseeded per scenario,
    // so leftover files on disk say nothing about which run created them.
    const root = makeTemporaryDirectory();
    const args = parseEvaluatorArgs([
      "--suite", "role", "--condition", "original", "--scenario", "implementer-tdd-evidence",
      "--repetitions", "1", "--model", "p/m:max", "--output", root,
    ]);
    const invocation = buildPiInvocation(args, 1);
    prepareRepetitionWorkspace(args, invocation);

    const before = captureFixtureIdentity(invocation.fixtureDir);
    expect(Object.keys(before).sort()).toEqual([
      "src/is-even.mjs",
      "task-brief.md",
      "tests/is-even.test.mjs",
    ]);

    writeFileSync(join(invocation.fixtureDir, "src/is-even.mjs"), "export const isEven = (v) => v % 2 === 0;\n");
    mkdirSync(join(invocation.fixtureDir, "reports"), { recursive: true });
    writeFileSync(join(invocation.fixtureDir, "reports/implementer-report.md"), "# report");

    const after = captureFixtureIdentity(invocation.fixtureDir);
    const diff = diffFixtureIdentity(before, after);
    expect(diff.changed).toEqual(["src/is-even.mjs"]);
    expect(diff.added).toEqual(["reports/implementer-report.md"]);
    expect(diff.removed).toEqual([]);
    // Both touched paths are declared, so this run mutated nothing unauthorized.
    expect(diff.unauthorized(args.scenario.allowedMutations)).toEqual([]);
  });

  it("flags a mutation outside the declared allowedMutations list", () => {
    const before = { "a.md": "h1", "b.md": "h2" };
    const after = { "a.md": "h1", "b.md": "CHANGED", "c.md": "new" };
    const diff = diffFixtureIdentity(before, after);
    expect(diff.unauthorized(["c.md"])).toEqual(["b.md"]);
  });

  it("configures each scenario's policy mode so the fake cannot contradict its prompt", () => {
    // exact-mode-dispatch states Exact mode with an invalid ladder in its prompt.
    // With policyMode unset the fake defaulted to tiered/directive-applied, so
    // the scenario could never observe the ignored-exact outcome it tests.
    const exact = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "exact-mode-dispatch",
      "--repetitions", "1", "--model", "p/m:max", "--output", "/tmp/o",
    ]);
    const exactEnv = buildPiInvocation(exact, 1).env;
    expect(exactEnv.SDD_EVAL_POLICY_MODE).toBe("exact");
    expect(exactEnv.SDD_EVAL_LADDER_VALID).toBe("false");

    // The recovery scenario is tiered: its subject is the crossed spawn window,
    // not a policy-mode change. Mode churn was only meaningful when a reused key
    // could return a stale application, which the runtime never offered.
    const recovery = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "dispatch-intent-crash-recovery",
      "--repetitions", "1", "--model", "p/m:max", "--output", "/tmp/o",
    ]);
    expect(buildPiInvocation(recovery, 1).env.SDD_EVAL_POLICY_MODE).toBe("tiered");

    // The mismatch scenario needs parent and child projections to disagree.
    const mismatch = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "dispatch-policy-mismatch",
      "--repetitions", "1", "--model", "p/m:max", "--output", "/tmp/o",
    ]);
    expect(buildPiInvocation(mismatch, 1).env.SDD_EVAL_CHILD_TIER_OVERRIDE).toBe("fast");
  });

  it("reports exact mode through the policy tool, not through the spawn result", async () => {
    const root = makeTemporaryDirectory();
    const tools = await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
      SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
      SDD_EVAL_POLICY_MODE: "exact",
      SDD_EVAL_LADDER_VALID: "false",
    });

    // Exact mode is a property of the parent's policy, which the controller
    // inspects before dispatching. The spawn result carries no policy evidence,
    // so a controller must gate on the inspection rather than on the response.
    const policy = JSON.parse(text(await tools.get("get_model_policy").execute("c1", {})));
    expect(policy.policy.mode).toBe("exact");
    expect(policy.ladder.valid).toBe(false);

    const result = JSON.parse(
      text(await tools.get("spawn_subsession").execute("c2", { prompt: "Implement Task 2.", cwd: "/w" })),
    );
    expect(Object.keys(result)).toEqual(["sessionId", "cwd"]);
  });

  it("shows a child whose effective tier disagrees with what was requested", async () => {
    const root = makeTemporaryDirectory();
    const tools = await loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
      SDD_EVAL_TOOL_LOG: join(root, "tool-log.jsonl"),
      SDD_EVAL_CHILD_TIER_OVERRIDE: "fast",
    });
    const parent = JSON.parse(
      text(await tools.get("spawn_subsession").execute("c1", { prompt: "Review Task 3.", cwd: "/w", tier: "standard" })),
    );
    const child = JSON.parse(
      text(await tools.get("read_subsession").execute("c2", { sessionId: parent.sessionId })),
    );

    // The controller cannot learn this from the spawn result, which returns only
    // { sessionId, cwd }. Confirming the tier bound requires inspecting the child.
    expect(child.requestedTier).toBe("standard");
    expect(child.effectiveTier).toBe("fast");
  });

  it("writes nothing outside the requested output directory", () => {
    const args = parseEvaluatorArgs([
      "--condition", "candidate", "--scenario", "missing-implementer-tier",
      "--repetitions", "1", "--model", "p/m:high", "--output", "/tmp/sdd-out",
    ]);
    const invocation = buildPiInvocation(args, 2);
    for (const path of [
      invocation.sessionDir,
      invocation.profileDir,
      invocation.fixtureDir,
      invocation.env.SDD_EVAL_TOOL_LOG,
    ]) {
      expect(path.startsWith("/tmp/sdd-out/")).toBe(true);
    }
  });
});
