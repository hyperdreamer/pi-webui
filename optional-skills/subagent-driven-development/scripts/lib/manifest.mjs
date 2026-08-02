/**
 * Runtime ownership manifest for the optional deterministic SDD skill.
 *
 * The manifest answers two questions a consumer cannot otherwise answer: which
 * package owns this skill, and whether the runtime tree on disk is the tree that
 * was generated. It deliberately does not answer "is this up to date" -- that
 * comparison belongs to an installer, which knows the installed version.
 *
 * The runtime list is explicit rather than globbed. A glob would silently absorb
 * a new file into the shipped surface; an explicit list makes every addition a
 * reviewed edit.
 */

import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Manifest schema version. Bump only for a breaking shape change. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Canonical skill name. Must match the `name` in `SKILL.md` frontmatter. */
export const SKILL_NAME = "subagent-driven-development";

/** Distribution posture. `opt-in` means never auto-registered by the package. */
export const DISTRIBUTION = "opt-in";

/**
 * Hash algorithm identifier.
 *
 * `sha256-path-nul-bytes-v1`: for each runtime file in sorted relative-path
 * order, absorb the UTF-8 relative path, a NUL, the raw file bytes, and a NUL.
 * The NUL delimiters make the encoding unambiguous: without them, a rename that
 * shifted bytes between path and content could preserve the digest.
 */
export const RUNTIME_HASH_ALGORITHM = "sha256-path-nul-bytes-v1";

/**
 * Files that constitute the runtime skill, sorted.
 *
 * Excludes `evals/` and `tests/` by construction: those carry fake capability
 * tools and adversarial prompts that must never reach a consumer's skill tree.
 */
export const RUNTIME_FILES = Object.freeze([
  "SKILL.md",
  "prompts/final-reviewer.md",
  "prompts/implementer.md",
  "prompts/re-reviewer.md",
  "prompts/task-reviewer.md",
  "references/capability-contract.md",
  "references/plan-contract.md",
  "references/state-machine.md",
  "scripts/lib/manifest.mjs",
  "scripts/lib/plan-policy.mjs",
  "scripts/lib/prompt-renderer.mjs",
  "scripts/lib/state-machine.mjs",
  "scripts/lib/state-store.mjs",
  "scripts/sdd-state",
  "scripts/sdd-state.mjs",
]);

const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Raised for any manifest validation or integrity failure. */
export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * Reject a runtime entry that is absolute, traverses upward, duplicates another,
 * or names excluded development evidence.
 *
 * Validation runs before any hashing so a rejected list never produces a digest.
 */
export function assertRuntimeList(runtimeFiles) {
  if (!Array.isArray(runtimeFiles) || runtimeFiles.length === 0) {
    throw new ManifestError("runtime file list must be a non-empty array");
  }

  const seen = new Set();
  for (const entry of runtimeFiles) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ManifestError("runtime entries must be non-empty strings");
    }
    if (isAbsolute(entry) || entry.startsWith("/")) {
      throw new ManifestError(`runtime entry must be relative: ${entry}`);
    }
    if (entry.includes("\\")) {
      throw new ManifestError(`runtime entry must use forward slashes: ${entry}`);
    }
    const segments = entry.split("/");
    if (segments.includes("..") || segments.includes(".") || segments.includes("")) {
      throw new ManifestError(`runtime entry must be a normalized path: ${entry}`);
    }
    if (entry.startsWith("evals/") || entry.startsWith("tests/")) {
      throw new ManifestError(`runtime entry must not ship development evidence: ${entry}`);
    }
    if (seen.has(entry)) {
      throw new ManifestError(`duplicate runtime entry: ${entry}`);
    }
    seen.add(entry);
  }

  const sorted = [...runtimeFiles].sort();
  if (sorted.some((entry, index) => entry !== runtimeFiles[index])) {
    throw new ManifestError("runtime file list must be sorted");
  }
  return sorted;
}

/**
 * Resolve a runtime entry against the source root.
 *
 * There is no second escape check here on purpose. `assertRuntimeList` runs first
 * on every path into this module and rejects absolute paths, backslashes, and any
 * `..` segment, so a validated entry cannot escape. A redundant guard here would
 * be unreachable, and an unreachable guard is worse than none: no test can pin it,
 * so it silently rots while implying a protection it never performs.
 *
 * Symlinks are a separate matter and deliberately not handled: the runtime list is
 * a frozen constant in this file, not caller input, so there is no untrusted path
 * by which a runtime entry could become a link out of the tree.
 */
function resolveInside(sourceRoot, relativePath) {
  return join(resolve(sourceRoot), relativePath);
}

/**
 * Compute the runtime digest over the validated, sorted list.
 *
 * Missing files surface as a `ManifestError` rather than a raw ENOENT, because a
 * manifest naming a file that does not exist is a manifest defect.
 */
export function computeRuntimeHash(sourceRoot, runtimeFiles = RUNTIME_FILES) {
  const sorted = assertRuntimeList(runtimeFiles);
  const hash = createHash("sha256");
  for (const relativePath of sorted) {
    const absolutePath = resolveInside(sourceRoot, relativePath);
    let bytes;
    try {
      bytes = readFileSync(absolutePath);
    } catch (cause) {
      throw new ManifestError(`runtime file is missing: ${relativePath}`, { cause });
    }
    hash.update(Buffer.from(relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

/** Read the owning package's name and version, validating the version is semver. */
function readSourcePackage(packageJsonPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (cause) {
    throw new ManifestError(`cannot read package manifest: ${packageJsonPath}`, { cause });
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new ManifestError("package manifest has no name");
  }
  if (typeof parsed.version !== "string" || !SEMVER_PATTERN.test(parsed.version)) {
    throw new ManifestError(`package version is not valid semver: ${String(parsed.version)}`);
  }
  return { name: parsed.name, version: parsed.version };
}

/** Build the manifest object without writing it. */
export function buildManifest({ sourceRoot, packageJsonPath, runtimeFiles = RUNTIME_FILES }) {
  const sorted = assertRuntimeList(runtimeFiles);
  const sourcePackage = readSourcePackage(packageJsonPath);
  // Hash last: a validation failure must never leave a digest to be trusted.
  const runtimeHash = computeRuntimeHash(sourceRoot, sorted);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    name: SKILL_NAME,
    distribution: DISTRIBUTION,
    sourcePackage,
    runtimeHashAlgorithm: RUNTIME_HASH_ALGORITHM,
    runtimeHash,
    runtimeFiles: sorted,
  };
}

/**
 * Write the manifest atomically.
 *
 * The digest is computed fully before the first byte is written, and the file
 * appears via `rename`, so a reader never observes a partial manifest or a
 * placeholder digest. There is no intermediate sentinel hash to leak.
 */
export function writeManifest({ sourceRoot, packageJsonPath, outputPath, runtimeFiles }) {
  const manifest = buildManifest({ sourceRoot, packageJsonPath, runtimeFiles });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const temporaryPath = `${outputPath}.tmp-${process.pid.toString(36)}`;
  writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o644 });
  renameSync(temporaryPath, outputPath);
  return manifest;
}

/** Parse and structurally validate a manifest file. */
export function readManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw new ManifestError(`cannot read manifest: ${manifestPath}`, { cause });
  }
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestError(`unsupported manifest schema version: ${String(parsed.schemaVersion)}`);
  }
  if (parsed.name !== SKILL_NAME) {
    throw new ManifestError(`unexpected skill name: ${String(parsed.name)}`);
  }
  if (parsed.distribution !== DISTRIBUTION) {
    throw new ManifestError(`unexpected distribution: ${String(parsed.distribution)}`);
  }
  if (parsed.runtimeHashAlgorithm !== RUNTIME_HASH_ALGORITHM) {
    throw new ManifestError(
      `unsupported runtime hash algorithm: ${String(parsed.runtimeHashAlgorithm)}`,
    );
  }
  if (typeof parsed.runtimeHash !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.runtimeHash)) {
    throw new ManifestError("runtime hash must be 64 lowercase hex characters");
  }
  assertRuntimeList(parsed.runtimeFiles);
  return parsed;
}

/**
 * Recompute the digest from the tree beside the manifest and compare.
 *
 * Returns the manifest and digest on success; throws on mismatch. The source root
 * is the manifest's own directory, so verification cannot be pointed at a
 * different tree by accident.
 */
export function verifyManifest(manifestPath, sourceRoot) {
  const manifest = readManifest(manifestPath);
  const actual = computeRuntimeHash(sourceRoot, manifest.runtimeFiles);
  if (actual !== manifest.runtimeHash) {
    throw new ManifestError(
      `runtime hash mismatch: manifest records ${manifest.runtimeHash} but the tree hashes to ${actual}`,
    );
  }
  return { manifest, runtimeHash: actual };
}

/** Absolute paths of the manifest's runtime files, for callers that copy the tree. */
export function runtimeFilePaths(sourceRoot, runtimeFiles = RUNTIME_FILES) {
  return assertRuntimeList(runtimeFiles).map((relativePath) =>
    join(resolve(sourceRoot), relativePath),
  );
}
