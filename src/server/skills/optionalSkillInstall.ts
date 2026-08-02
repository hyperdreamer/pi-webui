/**
 * Installs the repository's opt-in skills into the user's global skill directory.
 *
 * The shipped source directories carry a `deterministic-` prefix so they can sit
 * beside the upstream skills they derive from. Installation strips that prefix,
 * because sibling skills such as `brainstorming` route to `writing-plans` and
 * `subagent-driven-development` by name; installing under the prefixed names
 * would leave those references dangling.
 *
 * Stripping the prefix is not a directory rename. The name appears inside hashed
 * runtime files, so the caller must rewrite those occurrences and then regenerate
 * the runtime manifest, or `manifest-hash` reports a mismatch for a tree that is
 * otherwise correct.
 */

export interface OptionalSkillSpec {
  /** Directory name under `optional-skills/`, including the prefix. */
  readonly sourceName: string;
  /** Directory name to install as, without the prefix. */
  readonly installName: string;
}

export const OPTIONAL_SKILLS: readonly OptionalSkillSpec[] = Object.freeze([
  Object.freeze({
    sourceName: "deterministic-writing-plans",
    installName: "writing-plans",
  }),
  Object.freeze({
    sourceName: "deterministic-subagent-driven-development",
    installName: "subagent-driven-development",
  }),
]);

const PREFIX = "deterministic-";

/**
 * Rewrites prefixed skill names in a shipped text file to their installed names.
 *
 * Applies to every configured skill, not just the file's own, because the
 * authoring skill references the controller's directory as a sibling path.
 */
export function rewriteSkillNames(
  content: string,
  skills: readonly OptionalSkillSpec[] = OPTIONAL_SKILLS
): string {
  let result = content;
  for (const skill of skills) {
    result = result.split(skill.sourceName).join(skill.installName);
  }
  return result;
}

/** Strips the install prefix from a single name, leaving unprefixed names alone. */
export function stripSkillPrefix(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

export interface SkillLockDocument {
  readonly skills?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface LockPruneResult {
  /** The document to write back, with stale entries removed. */
  readonly document: SkillLockDocument;
  /** Names whose entries were present and removed. */
  readonly removed: readonly string[];
}

/**
 * Removes lock entries for skills this installer now owns.
 *
 * A stale entry is worse than a missing one: it names an upstream `sourceUrl`
 * and a folder hash that no longer matches the installed tree, so an updater
 * comparing them concludes the skill is out of date and overwrites it. With no
 * entry the server reports no install info at all, which is the documented
 * behavior for package-provided skills.
 */
export function pruneSkillLock(
  document: SkillLockDocument,
  skills: readonly OptionalSkillSpec[] = OPTIONAL_SKILLS
): LockPruneResult {
  const entries = document.skills;
  if (entries === undefined) return { document, removed: [] };

  const removed: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (skills.some((skill) => skill.installName === name)) {
      removed.push(name);
      continue;
    }
    kept[name] = value;
  }

  if (removed.length === 0) return { document, removed: [] };
  return { document: { ...document, skills: kept }, removed };
}
