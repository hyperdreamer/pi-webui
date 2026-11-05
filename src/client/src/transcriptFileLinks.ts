import type { Workspace } from "../../shared/apiTypes";
import { fileViewKindForPath } from "../../shared/fileViewTypes";
import { workspaceFileViewUrl } from "./api/urls";

/**
 * Everything recognition needs to turn a transcript target into an
 * application-relative file-view URL. `appBasePath` is the effective
 * application pathname, so a nested deployment's own namespace is excluded.
 */
export interface TranscriptFileLinkContext {
  cwd: string;
  projectId: string;
  workspaceId: string;
  machineId: string;
  appBasePath: string;
}

/** Names reserved for PI WEBUI's own application URLs. */
const RESERVED_NAMESPACES: readonly string[] = ["api", "pi-webui-plugins", "assets"];

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validBase(path: string): boolean {
  return /^\/(?!\/)[^?#\\]*$/u.test(path) && !hasControlCharacter(path);
}

const DRIVE_ROOT = /^[A-Za-z]:\/+$/u;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;

/** Slash/case normalization for comparison only; never resolves dot segments. */
function normalized(path: string): string {
  const slashes = path.replace(/\\/gu, "/");
  return slashes === "/" || DRIVE_ROOT.test(slashes)
    ? (slashes === "/" ? "/" : `${slashes.slice(0, 2)}/`)
    : slashes.replace(/\/+$/u, "");
}

function drive(path: string): boolean {
  return DRIVE_ABSOLUTE.test(path);
}

function equalPaths(a: string, b: string): boolean {
  const left = normalized(a);
  const right = normalized(b);
  return drive(left) && drive(right) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Decode percent escapes exactly once when every `%HH` run round-trips as
 * valid UTF-8. A malformed or invalid-UTF-8 escape keeps the whole original,
 * so a partially decoded prefix can never invent a path or scheme.
 */
function decodeOnce(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    for (const run of value.match(/(?:%[0-9a-f]{2})+/giu) ?? []) {
      const bytes = new TextEncoder().encode(decodeURIComponent(run));
      const encoded = [...bytes].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
      if (encoded.toLowerCase() !== run.toLowerCase()) return value;
    }
    return decoded;
  } catch { return value; }
}

/** Resolve the owning workspace for a session cwd, or nothing when ownership is incomplete. */
export function transcriptFileLinkContext(
  sessionCwd: string | undefined,
  workspaces: readonly Workspace[],
  machineId: string,
  appBasePath: string,
): TranscriptFileLinkContext | undefined {
  if (sessionCwd === undefined || sessionCwd === "" || machineId === "" || !validBase(appBasePath)) return undefined;
  const workspace = workspaces.find((candidate) => equalPaths(candidate.path, sessionCwd));
  if (workspace === undefined || workspace.id === "" || workspace.projectId === "") return undefined;
  return { cwd: sessionCwd, projectId: workspace.projectId, workspaceId: workspace.id, machineId, appBasePath };
}

/**
 * Recognize a local file target and resolve it onto its owning workspace's
 * file-view route. Returns `undefined` for every non-file target; traversal is
 * retained here so the server's authorization boundary decides it.
 */
export function resolveTranscriptFilePreviewUrl(
  rawTarget: string,
  context: TranscriptFileLinkContext,
): string | undefined {
  if (!context.cwd || !context.projectId || !context.workspaceId || !context.machineId || !validBase(context.appBasePath)) return undefined;
  const raw = rawTarget.trim();
  if (!raw || /^[#?]/u.test(raw) || raw.startsWith("//") || raw.startsWith("\\\\")) return undefined;
  const inspected = decodeOnce(raw);
  const isDrive = drive(inspected);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(inspected)?.[1]?.toLowerCase();
  // A drive prefix wins over the scheme test: Marked encodes the backslash, and
  // `C:` alone would otherwise read as an unsupported scheme.
  if (!isDrive && scheme !== undefined && scheme !== "file") return undefined;
  let path: string;
  let fragment = "";
  let fromFile = false;
  if (!isDrive && scheme === "file") {
    if (!/^file:\/\//iu.test(raw)) return undefined;
    let url: URL;
    try { url = new URL(raw); } catch { return undefined; }
    if ((url.hostname !== "" && url.hostname !== "localhost") || url.username || url.password || url.port) return undefined;
    path = url.pathname;
    fragment = url.hash;
    fromFile = true;
  } else {
    const hash = raw.indexOf("#");
    const beforeHash = hash < 0 ? raw : raw.slice(0, hash);
    if (hash >= 0) fragment = raw.slice(hash);
    const query = beforeHash.indexOf("?");
    path = query < 0 ? beforeHash : beforeHash.slice(0, query);
  }
  path = decodeOnce(path).replace(/\\/gu, "/");
  if (fromFile && /^\/[A-Za-z]:/u.test(path)) path = path.slice(1);
  while (path.startsWith("./")) path = path.slice(2);
  if (path.startsWith("//")) return undefined;
  const namespace = (path.startsWith("/") ? path.slice(1) : path).split("/", 1)[0];
  if (RESERVED_NAMESPACES.includes(namespace ?? "")) return undefined;
  const base = context.appBasePath.replace(/\/+$/u, "");
  if (base && path.startsWith("/") && (path === base || path.startsWith(`${base}/`))) return undefined;
  const absolute = path.startsWith("/") || drive(path);
  let requestPath = path;
  let cwdMatch = false;
  if (absolute) {
    const cwd = normalized(context.cwd);
    const candidate = normalized(path);
    const fold = drive(cwd) && drive(candidate);
    const comparable = fold ? candidate.toLowerCase() : candidate;
    const parent = fold ? cwd.toLowerCase() : cwd;
    if (comparable === parent) {
      requestPath = ".";
      cwdMatch = true;
    } else {
      // A child must cross a real separator boundary; `/ramdisk2` is not inside `/ramdisk`.
      const prefix = parent.endsWith("/") ? parent : `${parent}/`;
      if (comparable.startsWith(prefix)) {
        requestPath = path.slice(prefix.length);
        cwdMatch = true;
      }
    }
  }
  // Unknown extensions under the cwd still reach the server, which answers 415.
  if (!cwdMatch && fileViewKindForPath(path) === undefined) return undefined;
  return workspaceFileViewUrl(context.projectId, context.workspaceId, requestPath, { machineId: context.machineId }) + fragment;
}
