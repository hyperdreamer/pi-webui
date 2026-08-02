import { describe, expect, it } from "vitest";
import {
  createValidationPlan,
  createValidationSteps,
  parseNullDelimitedPaths,
} from "./verify-staged.mjs";

describe("staged validation planning", () => {
  it("parses NUL-delimited Git paths without breaking spaces", () => {
    expect(parseNullDelimitedPaths(Buffer.from("src/one.ts\0src/path with spaces/two.ts\0"))).toEqual([
      "src/one.ts",
      "src/path with spaces/two.ts",
    ]);
  });

  it("scopes ESLint and Vitest to staged source files", () => {
    const plan = createValidationPlan([
      "src/client/src/components/ChatView.ts",
      "src/client/src/components/ChatView.test.ts",
      "README.md",
    ], { pathExists: () => true });

    expect(plan).toEqual({
      paths: [
        "README.md",
        "src/client/src/components/ChatView.test.ts",
        "src/client/src/components/ChatView.ts",
      ],
      lint: {
        mode: "scoped",
        files: [
          "src/client/src/components/ChatView.test.ts",
          "src/client/src/components/ChatView.ts",
        ],
      },
      tests: {
        mode: "related",
        files: [
          "src/client/src/components/ChatView.test.ts",
          "src/client/src/components/ChatView.ts",
          "src/docker/piWebUiDockerDocs.test.ts",
        ],
      },
    });
  });

  it("does not lint deleted files but still gives them to Vitest dependency analysis", () => {
    const plan = createValidationPlan(["src/shared/deleted.ts"], { pathExists: () => false });

    expect(plan.lint).toEqual({ mode: "skip", files: [] });
    expect(plan.tests).toEqual({ mode: "related", files: ["src/shared/deleted.ts"] });
  });

  it("adds tests for repository assets that are read dynamically", () => {
    const plan = createValidationPlan([
      "docker/internal/image/install-opensuse-base",
      "pi-webui-plugins/updates/updatesLogic.ts",
    ], { pathExists: () => true });

    expect(plan.tests).toEqual({
      mode: "related",
      files: [
        "pi-webui-plugins/pluginPublicApi.test.ts",
        "pi-webui-plugins/updates/updatesLogic.ts",
        "src/docker/piWebUiDockerDocs.test.ts",
        "src/docker/piWebUiDockerEntrypoint.test.ts",
        "src/server/dockerControlAssets.test.ts",
      ],
    });
  });

  it("runs only the affected full validator when its configuration changes", () => {
    const eslintPlan = createValidationPlan(["eslint.config.js"], { pathExists: () => true });
    expect(eslintPlan.lint).toEqual({ mode: "full", files: [] });
    expect(eslintPlan.tests).toEqual({ mode: "skip", files: [] });

    const vitestPlan = createValidationPlan(["vitest.config.ts"], { pathExists: () => true });
    expect(vitestPlan.lint).toEqual({ mode: "scoped", files: ["vitest.config.ts"] });
    expect(vitestPlan.tests).toEqual({ mode: "full", files: [] });

    const typescriptPlan = createValidationPlan(["tsconfig.json"], { pathExists: () => true });
    expect(typescriptPlan.lint).toEqual({ mode: "full", files: [] });
    expect(typescriptPlan.tests).toEqual({ mode: "full", files: [] });
  });

  it("always includes cached typechecking and Knip before scoped checks", () => {
    const plan = createValidationPlan(["./src/path with spaces/example.ts"], { pathExists: () => true });

    expect(createValidationSteps(plan).map((step) => step.npmArgs)).toEqual([
      ["run", "typecheck:cached"],
      ["run", "knip"],
      ["exec", "--", "eslint", "--", "src/path with spaces/example.ts"],
      [
        "exec",
        "--",
        "vitest",
        "related",
        "--run",
        "--config",
        "vitest.config.ts",
        "--passWithNoTests",
        "src/path with spaces/example.ts",
      ],
    ]);
  });

  it("routes optional deterministic-SDD files through their complete validators", () => {
    const plan = createValidationPlan([
      "optional-skills/subagent-driven-development/scripts/sdd-state.mjs",
      "optional-skills/subagent-driven-development/SKILL.md",
    ], { pathExists: () => true });

    expect(plan.lint).toEqual({
      mode: "scoped",
      files: ["optional-skills/subagent-driven-development/scripts/sdd-state.mjs"],
    });
    expect(plan.tests).toEqual({
      mode: "related",
      files: [
        "optional-skills/subagent-driven-development/SKILL.md",
        "optional-skills/subagent-driven-development/evals/run-pressure-evals.test.mjs",
        "optional-skills/subagent-driven-development/scripts/sdd-state.mjs",
        "optional-skills/subagent-driven-development/tests/sdd-scripts.test.mjs",
        "optional-skills/subagent-driven-development/tests/sdd-state.test.mjs",
      ],
    });
  });
});
