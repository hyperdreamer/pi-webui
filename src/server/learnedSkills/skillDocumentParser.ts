import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { LearnedSkill } from "../../shared/apiTypes.js";

/**
 * Parse one learned-skill `SKILL.md` into structured fields. `name` and
 * `description` are required and trimmed; `version`, `created`, and `updated`
 * are hermes conventions, so they are optional. A present optional field with
 * the wrong type invalidates the document rather than emitting misleading
 * metadata, and malformed frontmatter is rejected the same way.
 */
export function parseLearnedSkillDocument(input: {
  id: string;
  filePath: string;
  content: string;
}): LearnedSkill | undefined {
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(input.content).frontmatter;
  } catch {
    return undefined;
  }

  const nameValue = frontmatter["name"];
  if (typeof nameValue !== "string" || nameValue.trim() === "") return undefined;

  const descriptionValue = frontmatter["description"];
  if (typeof descriptionValue !== "string" || descriptionValue.trim() === "") return undefined;

  const version = frontmatter["version"];
  if (version !== undefined && !(typeof version === "number" && Number.isFinite(version))) return undefined;

  const created = frontmatter["created"];
  if (created !== undefined && !(typeof created === "string" && created !== "")) return undefined;

  const updated = frontmatter["updated"];
  if (updated !== undefined && !(typeof updated === "string" && updated !== "")) return undefined;

  return {
    id: input.id,
    name: nameValue.trim(),
    description: descriptionValue.trim(),
    filePath: input.filePath,
    ...(version !== undefined ? { version } : {}),
    ...(created !== undefined ? { created } : {}),
    ...(updated !== undefined ? { updated } : {}),
  };
}
