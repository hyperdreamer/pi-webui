import { describe, expect, it } from "vitest";
import {
  formatNativeServiceDoctorResult,
  inferInstalledNativeServiceMode,
  inspectInstalledDevelopmentServiceInput,
  inspectInstalledProductionServiceContext,
  runNativeServiceDoctor,
  type InstalledNativeServiceDefinition,
  type NativeServiceDoctorTarget,
} from "./serviceDoctor.js";
import {
  createDevelopmentNativeServicePlan,
  type NativeServiceAuthoritativeProbe,
  type NativeServicePlan,
  type ProductionNativeServicePlanInput,
} from "./servicePlan.js";
import { renderLaunchdPlist, renderSystemdUnit } from "./serviceRendering.js";

const shell = {
  name: "zsh",
  executable: "/bin/zsh",
  source: "detected",
  detectedExecutable: "/bin/zsh",
} as const;

function productionInput(configured = false): ProductionNativeServicePlanInput {
  return {
    backend: { kind: "systemd", label: "systemd user services" },
    shell,
    environment: { PI_WEBUI_CONFIG: "/home/user/config.json" },
    executables: {
      sessiond: {
        configuredCommand: configured ? "custom sessiond --flag" : undefined,
        namedCommand: "pi-webui-sessiond",
        bundledEntrypointPath: "/package/sessiond.js",
      },
      web: {
        configuredCommand: configured ? "custom web --flag" : undefined,
        namedCommand: "pi-webui-server",
        bundledEntrypointPath: "/package/server.js",
      },
    },
  };
}

function probeWithStatus(status: "satisfied" | "unsatisfied"): NativeServiceAuthoritativeProbe {
  return {
    run: (request) => Promise.resolve({
      kind: "completed",
      outcomes: request.prerequisites.map((prerequisite) => ({
        prerequisiteId: prerequisite.id,
        status,
        detail: status === "satisfied" ? null : `${prerequisite.id} missing in manager context`,
      })),
    }),
  };
}

function developmentPlan(kind: "systemd" | "launchd"): NativeServicePlan {
  return createDevelopmentNativeServicePlan({
    backend: { kind, label: kind },
    shell,
    environment: { PI_WEBUI_CONFIG: "/home/user/config & dev.json" },
    workingDirectory: "/checkout with space",
    packageJsonPath: "/checkout with space/package.json",
  });
}

function renderedDefinitions(plan: NativeServicePlan): InstalledNativeServiceDefinition[] {
  return plan.services.map((service) => ({
    id: service.id,
    contents: plan.backend.kind === "systemd"
      ? renderSystemdUnit(plan, service)
      : renderLaunchdPlist(plan, service, "/tmp/logs"),
  }));
}

describe("installed native-service mode and definition inspection", () => {
  it("infers production, development, absent, and ambiguous service sets", () => {
    expect(inferInstalledNativeServiceMode(new Set())).toBe("none");
    expect(inferInstalledNativeServiceMode(new Set(["sessiond", "web"]))).toBe("production");
    expect(inferInstalledNativeServiceMode(new Set(["sessiond", "uiDev"]))).toBe("development");
    expect(inferInstalledNativeServiceMode(new Set(["web", "uiDev"]))).toBe("ambiguous");
    expect(inferInstalledNativeServiceMode(new Set(["sessiond"]))).toBe("ambiguous");
  });

  it.each(["systemd", "launchd"] as const)("reconstructs POSIX development paths from %s definitions on every host", (kind) => {
    const plan = developmentPlan(kind);
    expect(inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan))).toEqual({
      ok: true,
      value: {
        backend: plan.backend,
        shell,
        environment: { PI_WEBUI_CONFIG: "/home/user/config & dev.json" },
        workingDirectory: "/checkout with space",
        packageJsonPath: "/checkout with space/package.json",
      },
    });
  });

  it("reconstructs escaped systemd paths, substitutions, and line controls exactly", () => {
    const plan = createDevelopmentNativeServicePlan({
      backend: { kind: "systemd", label: "systemd" },
      shell: {
        name: "zsh",
        executable: "/shell $HOME/%h/zsh",
        source: "detected",
        detectedExecutable: "/shell $HOME/%h/zsh",
      },
      environment: { PI_WEBUI_CONFIG: "/config/%h\nnext" },
      workingDirectory: "/checkout %h\nnext",
      packageJsonPath: "/checkout %h\nnext/package.json",
    });

    expect(inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan))).toEqual({
      ok: true,
      value: {
        backend: plan.backend,
        shell: plan.shell,
        environment: plan.services[0]?.environment,
        workingDirectory: "/checkout %h\nnext",
        packageJsonPath: "/checkout %h\nnext/package.json",
      },
    });
  });

  it("interprets installed shell executable paths with POSIX semantics", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace('"/bin/zsh"', '"/bin/not-zsh\\\\zsh"'),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected the POSIX shell basename inspection to fail");
    expect(inspection.message).toContain("unsupported login shell");
  });

  it("inspects legacy systemd definitions without /usr/bin/env or quoted working directories", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents
        .replace("ExecStart=/usr/bin/env ", "ExecStart=")
        .replace("WorkingDirectory=/checkout\\x20with\\x20space", "WorkingDirectory=/checkout with space"),
    }));

    expect(inspectInstalledDevelopmentServiceInput(plan.backend, definitions)).toMatchObject({
      ok: true,
      value: { workingDirectory: "/checkout with space" },
    });
  });

  it("rejects quoted systemd working directories that the manager treats as non-absolute", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace(
        "WorkingDirectory=/checkout\\x20with\\x20space",
        'WorkingDirectory="/checkout with space"',
      ),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected quoted working directory inspection to fail");
    expect(inspection.message).toContain("invalid quoted working directory");
  });

  it("rejects unconsumed systemd environment syntax rather than checking a different context", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace("[Service]\n", "[Service]\nEnvironment=PATH=/custom/bin\n"),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected systemd environment inspection to fail");
    expect(inspection.message).toContain("environment entry");
  });

  it.each([
    'Environment="PI_WEBUI_CONFIG=/config" "PATH=/broken"',
    "EnvironmentFile=/tmp/pi-webui.env",
  ])("rejects noncanonical systemd environment context: %s", (directive) => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace("[Service]\n", `[Service]\n${directive}\n`),
    }));

    expect(inspectInstalledDevelopmentServiceInput(plan.backend, definitions).ok).toBe(false);
  });

  it("rejects duplicate systemd ExecStart directives", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace(
        "Restart=no",
        'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"\nRestart=no',
      ),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected duplicate ExecStart inspection to fail");
    expect(inspection.message).toContain("exactly one recognized ExecStart");
  });

  it("rejects malformed launchd environment dictionaries rather than dropping entries", () => {
    const plan = developmentPlan("launchd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace(
        "  </dict>\n  <key>RunAtLoad</key>",
        "    <key>BROKEN</key>\n    <integer>1</integer>\n  </dict>\n  <key>RunAtLoad</key>",
      ),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected launchd environment inspection to fail");
    expect(inspection.message).toContain("environment dictionary");
  });

  it("rejects a modified development command rather than claiming to check the installed plan", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan);
    const firstDefinition = definitions[0];
    if (firstDefinition === undefined) throw new Error("Expected a rendered service definition");
    definitions[0] = {
      ...firstDefinition,
      contents: firstDefinition.contents.replace("exec npm run start:sessiond", "exec npm run something-else"),
    };

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected development inspection to fail");
    expect(inspection.message).toContain("does not match the canonical development plan");
  });

  it("recovers production shell and environment while leaving executable strategy prospective", () => {
    const plan = developmentPlan("launchd");
    const firstService = plan.services[0];
    if (firstService === undefined) throw new Error("Expected a development service");
    const productionService = { ...firstService, workingDirectory: null };
    const productionPlan: NativeServicePlan = { ...plan, mode: "production", services: [productionService] };
    const productionLike = [{
      id: "sessiond" as const,
      contents: renderLaunchdPlist(productionPlan, productionService, "/tmp/logs"),
    }];
    expect(inspectInstalledProductionServiceContext(plan.backend, productionLike)).toEqual({
      ok: true,
      value: {
        shell,
        environment: { PI_WEBUI_CONFIG: "/home/user/config & dev.json" },
      },
    });
  });
});

describe("native-service doctor planning and reporting", () => {
  it("validates installed development requirements without production binary checks", async () => {
    const plan = developmentPlan("launchd");
    const inspected = inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan));
    if (!inspected.ok) throw new Error(inspected.message);

    const result = await runNativeServiceDoctor(
      { kind: "installed-development", input: inspected.value },
      { probe: probeWithStatus("satisfied"), fileExists: () => false },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(report.ok).toBe(true);
    expect(report.lines).toContain("Installed development native-service plan:");
    expect(report.plan?.services.flatMap((service) => service.prerequisites)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "pi-webui-server" })]),
    );
  });

  it("does not recommend PATH changes for checkout metadata failures", async () => {
    const plan = developmentPlan("systemd");
    const inspected = inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan));
    if (!inspected.ok) throw new Error(inspected.message);
    const result = await runNativeServiceDoctor(
      { kind: "installed-development", input: inspected.value },
      {
        probe: {
          run: (request) => Promise.resolve({
            kind: "completed",
            outcomes: request.prerequisites.map((prerequisite) => ({
              prerequisiteId: prerequisite.id,
              status: prerequisite.kind === "package-scripts" ? "unsatisfied" as const : "satisfied" as const,
              detail: prerequisite.kind === "package-scripts" ? "scripts missing" : null,
            })),
          }),
        },
        fileExists: () => true,
      },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(report).toMatchObject({ ok: false, failureKind: "requirements", pathAdviceRecommended: false });
  });

  it("labels a production check as prospective and reports manager-context requirements", async () => {
    const target: NativeServiceDoctorTarget = {
      kind: "prospective-production",
      input: productionInput(),
      reason: "installed executable strategy is not recorded",
    };
    const result = await runNativeServiceDoctor(target, {
      probe: probeWithStatus("unsatisfied"),
      fileExists: () => true,
    });
    const report = formatNativeServiceDoctorResult(result);

    expect(report.ok).toBe(false);
    expect(report.failureKind).toBe("requirements");
    expect(report.lines[0]).toContain("Prospective production native-service plan");
    expect(report.lines.join("\n")).toContain("Native service requirement failed");
    expect(report.failedPrerequisites).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "node-version" }),
      expect.objectContaining({ kind: "readable-file" }),
    ]));
  });

  it("retains the installed production shell when resolution fails before a plan exists", async () => {
    const result = await runNativeServiceDoctor(
      { kind: "prospective-production", input: productionInput(), reason: "installed strategy is unknown" },
      { probe: probeWithStatus("unsatisfied"), fileExists: () => false },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(report).toMatchObject({
      ok: false,
      failureKind: "requirements",
      plan: null,
      adviceShell: shell,
      pathAdviceRecommended: true,
    });
  });

  it("preserves configured overrides as unverified and does not probe arbitrary commands", async () => {
    let calls = 0;
    const result = await runNativeServiceDoctor(
      { kind: "prospective-production", input: productionInput(true), reason: "current configured overrides" },
      {
        probe: { run: () => { calls += 1; return Promise.resolve({ kind: "completed", outcomes: [] }); } },
        fileExists: () => false,
      },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(calls).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("does not execute arbitrary configured commands");
  });

  it.each(["manager", "timeout", "malformed-output", "cleanup"] as const)(
    "distinguishes %s infrastructure failures from PATH requirement drift",
    async (reason) => {
      const result = await runNativeServiceDoctor(
        { kind: "prospective-production", input: productionInput(), reason: "no installed services" },
        {
          probe: { run: () => Promise.resolve({ kind: "infrastructure-failure", reason, message: `${reason} failure` }) },
          fileExists: () => true,
        },
      );
      const report = formatNativeServiceDoctorResult(result);

      expect(report.ok).toBe(false);
      expect(report.failureKind).toBe("infrastructure");
      expect(report.lines.join("\n")).toContain(`infrastructure failure (${reason})`);
      expect(report.lines.join("\n")).toContain("not proof of a PATH mismatch");
    },
  );

  it("makes mixed or malformed installed definitions a failing inspection result", async () => {
    const result = await runNativeServiceDoctor(
      { kind: "inspection-failure", message: "production and development service IDs are both installed" },
      { probe: probeWithStatus("satisfied"), fileExists: () => true },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(report).toMatchObject({ ok: false, failureKind: "inspection" });
    expect(report.lines.join("\n")).toContain("could not be inspected");
  });
});
