/**
 * Deterministic prompt rendering.
 *
 * A rendered prompt is dispatch input whose exact bytes are stored in state and
 * reissued verbatim on recovery. Rendering is therefore a pure function of
 * (tier, role, context): no clock, no working directory, no environment, no
 * template evaluation.
 *
 * There is deliberately no general-purpose templating here. A template engine
 * would let a context value introduce a directive, a heading, or another
 * placeholder, and the prompt is the one artifact a child treats as instructions.
 * Role contracts are static files copied verbatim; context is emitted as a
 * validated, escaped key/value list.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { TIERS } from "./plan-policy.mjs";

/** Maximum bytes for a rendered prompt, matching the dispatch-intent bound. */
const MAX_PROMPT_BYTES = 384 * 1024;

/** Maximum UTF-8 bytes for any single path. */
const MAX_PATH_BYTES = 4096;

/** Maximum finding records the contract allows in one ledger. */
const MAX_FINDING_IDS = 256;

const TIER_SET = new Set(TIERS);

/** A rejected render. */
export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = "RenderError";
  }
}

const fail = (message) => {
  throw new RenderError(message);
};

/**
 * Role definitions.
 *
 * `paths` and `scalars` are the complete accepted key set for each role. Anything
 * else is rejected rather than ignored, so a typo in a context file fails loudly
 * instead of silently omitting information a child needed.
 */
const ROLES = Object.freeze({
  implementer: {
    template: "implementer.md",
    paths: ["briefPath", "reportPath"],
    scalars: ["task"],
    optional: ["contextPath", "findingPackagePath", "baseSha", "headSha", "round"],
  },
  "task-reviewer": {
    template: "task-reviewer.md",
    paths: ["briefPath", "reportPath"],
    scalars: ["task"],
    optional: ["baseSha", "headSha", "reviewPackagePath"],
  },
  "re-reviewer": {
    template: "re-reviewer.md",
    paths: ["briefPath", "reportPath"],
    scalars: ["task"],
    optional: ["baseSha", "headSha", "reviewPackagePath", "findingIds", "round"],
  },
  "final-reviewer": {
    template: "final-reviewer.md",
    paths: ["briefPath", "reportPath"],
    scalars: ["task"],
    optional: ["baseSha", "headSha", "reviewPackagePath", "findingIds", "ledgerPath"],
  },
});

/** Keys every role pins, naming the roots that confine every other path. */
const ROOT_KEYS = Object.freeze(["worktree", "runRoot"]);

/** Emission order. Fixed, because byte-exact output cannot depend on key order. */
const FIELD_ORDER = Object.freeze([
  "worktree",
  "runRoot",
  "task",
  "round",
  "baseSha",
  "headSha",
  "briefPath",
  "contextPath",
  "reportPath",
  "reviewPackagePath",
  "findingPackagePath",
  "ledgerPath",
  "findingIds",
]);

const SHA = /^[0-9a-f]{40}$/u;
const FINDING_ID = /^[A-Za-z0-9._:-]{1,64}$/u;

/** Reject control characters anywhere in a rendered value. */
const requireClean = (value, field) => {
  // eslint-disable-next-line no-control-regex -- rejecting these is the point.
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${field} must not contain a control character`);
  }
  return value;
};

/**
 * Validate a path: absolute, normalized, bounded, and confined to a pinned root.
 *
 * When the path already exists its real path is checked too, so a symlink cannot
 * point a "confined" path at content outside the run. For an output path the real
 * parent is checked, since the file itself will not exist yet.
 */
const validatePath = (value, field, roots, { mustExist = false } = {}) => {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  requireClean(value, field);
  if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    fail(`${field} exceeds ${String(MAX_PATH_BYTES)} bytes`);
  }
  if (!isAbsolute(value)) fail(`${field} must be an absolute path: ${value}`);
  if (value.split("/").includes("..")) {
    fail(`${field} must be normalized and contain no ".." segment`);
  }

  const within = (candidate) =>
    roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));

  if (!within(resolve(value))) {
    fail(`${field} must live beneath a pinned root: ${value}`);
  }

  let real;
  try {
    real = realpathSync(value);
  } catch {
    real = null;
  }
  if (real === null && mustExist) fail(`${field} does not exist: ${value}`);
  if (real !== null && !within(real)) {
    fail(`${field} resolves outside the pinned roots via a symlink: ${value} -> ${real}`);
  }
  if (real === null) {
    // The file may legitimately not exist yet; its parent still must not escape.
    let parentReal;
    try {
      parentReal = realpathSync(dirname(value));
    } catch {
      fail(`${field} names a directory that does not exist: ${dirname(value)}`);
    }
    if (!within(parentReal)) {
      fail(`${field} has a real parent outside the pinned roots: ${parentReal}`);
    }
  }
  return value;
};

/** Render one context value as a single line. */
const renderValue = (key, value) => {
  if (Array.isArray(value)) return `- ${key}: ${value.join(", ")}`;
  if (typeof value === "number") return `- ${key}: ${String(value)}`;
  return `- ${key}: ${value}`;
};

/**
 * Validate a context object against its role.
 *
 * Returns the accepted subset in a fixed emission order.
 */
const validateContext = (role, context) => {
  const definition = ROLES[role];
  const accepted = new Set([
    ...ROOT_KEYS,
    ...definition.paths,
    ...definition.scalars,
    ...definition.optional,
  ]);

  const unexpected = Object.keys(context).filter((key) => !accepted.has(key));
  if (unexpected.length > 0) {
    fail(`unexpected context key(s) for role ${role}: ${unexpected.join(", ")}`);
  }

  for (const key of ROOT_KEYS) {
    const value = context[key];
    if (typeof value !== "string" || !isAbsolute(value)) {
      fail(`${key} must be a pinned absolute path`);
    }
  }
  const roots = ROOT_KEYS.map((key) => resolve(context[key]));

  for (const key of definition.paths) {
    if (context[key] === undefined) fail(`role ${role} requires ${key}`);
    validatePath(context[key], key, roots);
  }
  for (const key of definition.scalars) {
    const value = context[key];
    if (!Number.isInteger(value) || value < 1) {
      fail(`${key} must be a positive integer for role ${role}`);
    }
  }

  for (const key of definition.optional) {
    const value = context[key];
    if (value === undefined) continue;
    if (key.endsWith("Path")) {
      validatePath(value, key, roots);
    } else if (key === "baseSha" || key === "headSha") {
      if (typeof value !== "string" || !SHA.test(value)) {
        fail(`${key} must be a 40-character lowercase hex object name`);
      }
    } else if (key === "round") {
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        fail("round must be an integer from 1 to 5");
      }
    } else if (key === "findingIds") {
      if (!Array.isArray(value)) fail("findingIds must be an array");
      if (value.length > MAX_FINDING_IDS) {
        fail(
          `findingIds holds ${String(value.length)} entries, exceeding the ${String(MAX_FINDING_IDS)}-finding bound`,
        );
      }
      for (const [index, id] of value.entries()) {
        if (typeof id !== "string" || !FINDING_ID.test(id)) {
          fail(`findingIds[${String(index)}] must match ^[A-Za-z0-9._:-]{1,64}$`);
        }
      }
    } else {
      fail(`no validation rule for optional key ${key}`);
    }
  }

  return FIELD_ORDER.filter((key) => context[key] !== undefined).map((key) => [key, context[key]]);
};

/**
 * Render a prompt.
 *
 * Byte layout, fixed by contract because dispatch stores and reissues these bytes:
 *
 *   /tier-<tier>\n
 *   \n
 *   <role contract, trailing whitespace trimmed>\n
 *   \n
 *   ## Dispatch Context\n\n<one "- key: value" line each>\n
 *   \n
 *   ## Return Channel\n\n<two lines>\n
 */
export function renderPrompt({ tier, role, context, skillRoot }) {
  if (!TIER_SET.has(tier)) {
    fail(`unknown tier: ${String(tier)} (expected one of ${TIERS.join(", ")})`);
  }
  const definition = ROLES[role];
  if (definition === undefined) {
    fail(`unknown role: ${String(role)} (expected one of ${Object.keys(ROLES).join(", ")})`);
  }

  const fields = validateContext(role, context);
  const template = readFileSync(join(skillRoot, "prompts", definition.template), "utf8");

  const rendered = [
    `/tier-${tier}`,
    "",
    template.trimEnd(),
    "",
    "## Dispatch Context",
    "",
    ...fields.map(([key, value]) => renderValue(key, value)),
    "",
    "## Return Channel",
    "",
    `Write exactly one report at ${context.reportPath}.`,
    "Return exactly one status token defined by your role contract above.",
    "",
  ].join("\n");

  if (Buffer.byteLength(rendered, "utf8") > MAX_PROMPT_BYTES) {
    fail(
      `rendered prompt is ${String(Buffer.byteLength(rendered, "utf8"))} bytes, exceeding ${String(MAX_PROMPT_BYTES)} (384 KiB)`,
    );
  }
  if (rendered.includes("{{")) {
    fail("rendered prompt contains an unresolved template marker");
  }
  return rendered;
}
