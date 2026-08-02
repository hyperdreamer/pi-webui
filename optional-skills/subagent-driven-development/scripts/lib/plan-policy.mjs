/**
 * Plan parsing and tier derivation for the deterministic SDD controller.
 *
 * The acceptance grammar below is the single source of truth. Documentation may
 * restate it but never redefines it.
 */

/**
 * The frozen tier ladder, in ascending capability order.
 *
 * Lowercase is the identifier, matching `MODEL_TIERS` in PI WEBUI's shared API
 * types, the `modelTiers` config keys, and the `tier` parameter that
 * `spawn_subsession` accepts. TitleCase exists only for display: plan files
 * write `**Implementer tier:** Advanced` because a human writes and reviews
 * them, and the parser normalizes that to `advanced` at the boundary. Keeping
 * one conversion point here means no dispatch site needs to remember to
 * lowercase a tier before handing it to the tool.
 */
export const TIERS = Object.freeze([
  "economy",
  "fast",
  "standard",
  "advanced",
  "capable",
  "frontier",
]);

/** Display labels, mirroring the settings panel's tier label map. */
const TIER_LABELS = Object.freeze({
  economy: "Economy",
  fast: "Fast",
  standard: "Standard",
  advanced: "Advanced",
  capable: "Capable",
  frontier: "Frontier",
});

const TASK_HEADING = /^## Task ([1-9][0-9]*): (\S(?:.*\S)?)$/u;
const TIER_FIELD = /^\*\*Implementer tier:\*\* (Economy|Fast|Standard|Advanced|Capable|Frontier)$/u;
const GLOBAL_HEADING = /^## Global Constraints$/u;
const TASK_LIKE_ATX = /^ {0,3}#{1,}[ \t]+Task\b/u;
const BACKTICK_OPEN = /^ {0,3}(`{3,})([^`]*)$/u;
const TILDE_OPEN = /^ {0,3}(~{3,})(.*)$/u;
const ANY_H2 = /^## /u;
const INDENTED_CODE = /^ {4,}/u;

const STANDARD_FLOOR_INDEX = TIERS.indexOf("standard");
const FRONTIER_INDEX = TIERS.length - 1;

/** Rungs added to the implementer tier for each fix round. */
const FIX_ROUND_ESCALATION = Object.freeze({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 });

/**
 * The single validating tier lookup every formula resolves through.
 *
 * Accepts only the lowercase identifier. A TitleCase value reaching this point
 * means a caller bypassed the parser's normalization, which is a defect worth
 * failing on rather than silently coercing.
 */
function tierIndex(tier) {
  const index = TIERS.indexOf(tier);
  if (index < 0) throw new Error(`unknown tier: ${String(tier)}`);
  return index;
}

/** The display label for a tier, for prose and human-facing output. */
export function tierLabel(tier) {
  return TIER_LABELS[TIERS[tierIndex(tier)]];
}

function cap(index) {
  return TIERS[Math.min(index, FRONTIER_INDEX)];
}

/**
 * Reviewers sit one rung above the implementer, never below Standard and never
 * above Frontier.
 */
export function reviewerTier(implementer) {
  return cap(Math.max(STANDARD_FLOOR_INDEX, tierIndex(implementer) + 1));
}

/** Re-reviewers use the same derivation as reviewers. */
export function reReviewerTier(implementer) {
  return reviewerTier(implementer);
}

/** Fixers match the implementer through round 3, then escalate. */
export function fixerTier(implementer, round) {
  const index = tierIndex(implementer);
  if (!Number.isInteger(round) || round < 1 || round > 5) {
    throw new Error(`fix round must be an integer from 1 through 5, received ${String(round)}`);
  }
  return cap(index + FIX_ROUND_ESCALATION[round]);
}

/** The final reviewer always runs at the top of the ladder. */
export function finalReviewerTier() {
  return TIERS[FRONTIER_INDEX];
}

/**
 * The human-readable echo for a tier.
 *
 * This is display text, not a control channel. `spawn_subsession` selects a
 * model from its typed `tier` parameter; a `/tier-*` line in a rendered prompt
 * has no effect on which model runs. It exists so a human reading a transcript
 * can see the intended tier, and so renderer/formula divergence is detectable.
 */
export function tierDirective(tier) {
  return `/tier-${TIERS[tierIndex(tier)]}`;
}

const ROLES = Object.freeze({
  implementer: { needsRound: false, resolve: (tier) => TIERS[tierIndex(tier)] },
  "task-reviewer": { needsRound: false, resolve: reviewerTier },
  "re-reviewer": { needsRound: false, resolve: reReviewerTier },
  final: { needsRound: false, resolve: () => finalReviewerTier() },
  fixer: { needsRound: true, resolve: fixerTier },
});

/**
 * Resolve one role's tier and its directive.
 *
 * The round argument is required for the fixer role and rejected for every other
 * role, so a caller cannot silently pass a round that has no effect.
 */
export function roleTier({ implementer, role, round }) {
  const definition = ROLES[role];
  if (definition === undefined) throw new Error(`unknown role: ${String(role)}`);

  if (definition.needsRound && round === undefined) {
    throw new Error(`role ${role} requires a fix round`);
  }
  if (!definition.needsRound && round !== undefined) {
    throw new Error(`role ${role} does not accept a fix round`);
  }

  const tier = definition.needsRound
    ? definition.resolve(implementer, round)
    : definition.resolve(implementer);
  return { tier, directive: tierDirective(tier) };
}

class PlanError extends Error {
  constructor(message, planPath, lineNumber) {
    super(`${planPath}:${String(lineNumber)}: ${message}`);
    this.name = "PlanError";
    this.planPath = planPath;
    this.lineNumber = lineNumber;
  }
}

/**
 * Detect a fence opener. Returns `{ marker, length }`, `"invalid"` for a
 * marker-like line that violates its opener grammar, or `null` for prose.
 */
function fenceOpener(line) {
  // Four-or-more-space indented code is ordinary content, never a fence.
  if (INDENTED_CODE.test(line)) return null;

  const backtick = BACKTICK_OPEN.exec(line);
  if (backtick !== null) return { marker: "`", length: backtick[1].length };

  const tilde = TILDE_OPEN.exec(line);
  if (tilde !== null) return { marker: "~", length: tilde[1].length };

  // A line that starts with three or more markers but matched no opener grammar
  // is rejected rather than silently treated as prose.
  if (/^ {0,3}`{3,}/u.test(line) || /^ {0,3}~{3,}/u.test(line)) return "invalid";
  return null;
}

/** Does `line` close a fence opened with `opener`? */
function closesFence(line, opener) {
  if (INDENTED_CODE.test(line)) return false;
  const pattern = opener.marker === "`"
    ? /^ {0,3}(`{3,})[ \t]*$/u
    : /^ {0,3}(~{3,})[ \t]*$/u;
  const match = pattern.exec(line);
  return match !== null && match[1].length >= opener.length;
}

export function parsePlanText(planText, planPath = "<plan>") {
  const lines = String(planText).replaceAll("\r\n", "\n").split("\n");

  let globalConstraints = null;
  let sawGlobalConstraints = false;
  const tasks = [];
  /** The section currently collecting body lines, or null. */
  let current = null;
  let openFence = null;
  let openFenceLine = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (openFence !== null) {
      // Inside a fence, test the closer before any opener logic.
      if (closesFence(line, openFence)) {
        openFence = null;
      }
      if (current !== null) current.body.push(line);
      continue;
    }

    const opener = fenceOpener(line);
    if (opener === "invalid") {
      throw new PlanError("malformed fence opener", planPath, lineNumber);
    }
    if (opener !== null) {
      openFence = opener;
      openFenceLine = lineNumber;
      if (current !== null) current.body.push(line);
      continue;
    }

    const taskMatch = TASK_HEADING.exec(line);
    if (taskMatch !== null) {
      current = {
        kind: "task",
        number: Number(taskMatch[1]),
        title: taskMatch[2],
        implementerTier: null,
        tierLine: 0,
        body: [],
        headingLine: lineNumber,
      };
      tasks.push(current);
      continue;
    }

    if (GLOBAL_HEADING.test(line)) {
      if (sawGlobalConstraints) {
        throw new PlanError("duplicate Global Constraints section", planPath, lineNumber);
      }
      if (tasks.length > 0) {
        throw new PlanError("Global Constraints must precede the first task", planPath, lineNumber);
      }
      sawGlobalConstraints = true;
      current = { kind: "global", body: [] };
      globalConstraints = current;
      continue;
    }

    // Any task-like ATX heading outside a fence that is not canonical is an
    // error. The diagnostic names the depth found, the depth required, and the
    // tier line, because the most common source of a non-canonical plan is the
    // `writing-plans` skill, which emits `### Task N:` with no tier field. A bare
    // "not canonical" would leave the operator guessing at two separate repairs.
    if (TASK_LIKE_ATX.test(line) && !INDENTED_CODE.test(line)) {
      const depth = /^ {0,3}(#+)/u.exec(line)?.[1] ?? "#";
      const title = line.replace(/^ {0,3}#+[ \t]+/u, "");
      throw new PlanError(
        [
          `task-like heading is not canonical: ${line}`,
          `found heading depth "${depth}" but the deterministic controller requires "##"`,
          `rewrite it as: ## ${title.startsWith("Task") ? title : `Task N: ${title}`}`,
          'and give every task a tier line on its own: **Implementer tier:** Advanced',
          "a tier-annotated plan is a precondition of tiered dispatch; the controller never guesses a tier",
        ].join("\n  "),
        planPath,
        lineNumber,
      );
    }

    // A non-canonical H2 terminates the open section without being captured.
    if (ANY_H2.test(line)) {
      current = null;
      continue;
    }

    if (current === null) continue;

    if (current.kind === "task") {
      const tierMatch = TIER_FIELD.exec(line);
      if (tierMatch !== null) {
        if (current.implementerTier !== null) {
          throw new PlanError(
            `duplicate Implementer tier for Task ${String(current.number)}`,
            planPath,
            lineNumber,
          );
        }
        // Plan files carry TitleCase for readability; the identifier is
        // lowercase everywhere past this boundary.
        current.implementerTier = tierMatch[1].toLowerCase();
        current.tierLine = lineNumber;
        continue;
      }
      // A tier-like line that failed the exact grammar is a hard error.
      if (/^\s*\*\*Implementer tier:\*\*/u.test(line)) {
        throw new PlanError(`malformed Implementer tier field: ${line}`, planPath, lineNumber);
      }
    }

    current.body.push(line);
  }

  if (openFence !== null) {
    throw new PlanError("unterminated fence", planPath, openFenceLine);
  }
  if (tasks.length === 0) {
    throw new PlanError("plan declares no tasks", planPath, lines.length);
  }

  for (let position = 0; position < tasks.length; position += 1) {
    const task = tasks[position];
    const expected = position + 1;
    if (task.number !== expected) {
      throw new PlanError(
        `expected Task ${String(expected)} but found Task ${String(task.number)}`,
        planPath,
        task.headingLine,
      );
    }
    if (task.implementerTier === null) {
      throw new PlanError(
        `Task ${String(task.number)} has no Implementer tier
  add a line reading exactly: **Implementer tier:** <Economy|Fast|Standard|Advanced|Capable|Frontier>
  a tier-annotated plan is a precondition of tiered dispatch; the controller never guesses a tier`,
        planPath,
        task.headingLine,
      );
    }
  }

  return {
    planPath,
    globalConstraints: globalConstraints === null
      ? null
      : globalConstraints.body.join("\n").trim(),
    tasks: tasks.map((task) => ({
      number: task.number,
      title: task.title,
      implementerTier: task.implementerTier,
      body: task.body.join("\n").trim(),
    })),
  };
}
