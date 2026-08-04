import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  parseSessionEntries,
  SessionManager,
  SettingsManager,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import type { PiSessionListEntry, PiSessionManager, PiSessionManagerGateway } from "./piSessionService.js";
import {
  inspectSessionCreationSource,
  SESSION_CREATION_SOURCE_CUSTOM_TYPE,
} from "./sessionCreationSource.js";

const MAX_CONCURRENT_SESSION_LIST_LOADS = 10;

type SessionDirSource = "env" | "settings" | "pi-default";

export interface SessionDirResolution {
  source: SessionDirSource;
  sessionDir: string;
  usesConfiguredSessionDir: boolean;
}

export interface SessionDirResolverOptions {
  agentDir: string;
  env: Readonly<NodeJS.ProcessEnv>;
  sessionDirEnvKeys: readonly string[];
}

export class SessionDirResolver {
  private readonly agentDir: string;
  private readonly envSessionDir: string | undefined;
  private readonly homeDir: string;

  constructor(options: SessionDirResolverOptions) {
    this.agentDir = options.agentDir;
    this.envSessionDir = options.sessionDirEnvKeys
      .map((key) => options.env[key])
      .find((value) => value !== undefined && value !== "");
    const configuredHome = options.env["HOME"];
    this.homeDir = configuredHome !== undefined && configuredHome !== "" && isAbsolute(configuredHome) ? configuredHome : homedir();
  }

  defaultSessionsRoot(): string {
    return defaultPiSessionsRoot(this.agentDir);
  }

  globalEnvSessionDir(): string | undefined {
    if (this.envSessionDir === undefined) return undefined;
    const expanded = expandTildePath(this.envSessionDir, this.homeDir);
    return isAbsolute(expanded) ? expanded : undefined;
  }

  resolve(cwd: string): SessionDirResolution {
    if (this.envSessionDir !== undefined) {
      return { source: "env", sessionDir: resolveConfiguredPath(this.envSessionDir, cwd, this.homeDir), usesConfiguredSessionDir: true };
    }

    const settingsSessionDir = SettingsManager.create(cwd, this.agentDir).getSessionDir();
    if (settingsSessionDir !== undefined && settingsSessionDir !== "") {
      return { source: "settings", sessionDir: resolveConfiguredPath(settingsSessionDir, cwd, this.homeDir), usesConfiguredSessionDir: true };
    }

    return { source: "pi-default", sessionDir: defaultPiSessionDir(cwd, this.agentDir), usesConfiguredSessionDir: false };
  }
}

export type PiSessionManagerGatewayOptions = SessionDirResolverOptions;

export function createPiSessionManagerGateway(options: PiSessionManagerGatewayOptions): PiSessionManagerGateway {
  return new SettingsAwarePiSessionManagerGateway(new SessionDirResolver(options));
}

class SettingsAwarePiSessionManagerGateway implements PiSessionManagerGateway {
  constructor(private readonly resolver: SessionDirResolver) {}

  async list(cwd: string): Promise<PiSessionListEntry[]> {
    const resolution = this.resolver.resolve(cwd);
    return filterSessionsForCwd(await listSessionsInDir(resolution.sessionDir), cwd);
  }

  create(cwd: string, options?: { parentSession?: string }): PiSessionManager {
    const resolution = this.resolver.resolve(cwd);
    return SessionManager.create(cwd, resolution.sessionDir, options?.parentSession === undefined ? undefined : { parentSession: options.parentSession });
  }

  async listAll(): Promise<PiSessionListEntry[]> {
    const envSessionDir = this.resolver.globalEnvSessionDir();
    const [defaultSessions, envSessions] = await Promise.all([
      listSessionsInDefaultPiStore(this.resolver.defaultSessionsRoot()),
      envSessionDir === undefined ? Promise.resolve([]) : listSessionsInDir(envSessionDir),
    ]);
    return uniqueSessionsByPath([...defaultSessions, ...envSessions]);
  }

  open(path: string): PiSessionManager {
    return SessionManager.open(path, dirname(path));
  }
}

export async function listSessionsInDir(sessionDir: string): Promise<PiSessionListEntry[]> {
  // Listing and source inspection share one asynchronous JSONL pass. Constructing
  // a persisted SessionManager here would migrate legacy files as a side effect.
  let files: string[];
  try {
    files = (await readdir(sessionDir))
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => join(sessionDir, file));
  } catch {
    return [];
  }

  const sessions: PiSessionListEntry[] = [];
  for (
    let index = 0;
    index < files.length;
    index += MAX_CONCURRENT_SESSION_LIST_LOADS
  ) {
    const batch = await Promise.all(
      files
        .slice(index, index + MAX_CONCURRENT_SESSION_LIST_LOADS)
        .map((file) => readSessionListEntry(file))
    );
    for (const session of batch) {
      if (session !== undefined) sessions.push(session);
    }
  }

  return sessions.sort(
    (left, right) => right.modified.getTime() - left.modified.getTime()
  );
}

async function readSessionListEntry(
  path: string
): Promise<PiSessionListEntry | undefined> {
  try {
    const stats = await stat(path);
    const lines = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let header: SessionHeader | undefined;
    let name: string | undefined;
    let messageCount = 0;
    let firstMessage = "";
    const allMessages: string[] = [];
    let lastActivityTime: number | undefined;
    let newestCreationSourceEntry: unknown;

    for await (const line of lines) {
      for (const parsed of parseSessionEntries(line)) {
        if (!isRecord(parsed)) continue;
        if (header === undefined) {
          if (parsed.type !== "session") return undefined;
          header = parsed;
          continue;
        }
        if (
          parsed.type === "custom" &&
          parsed.customType === SESSION_CREATION_SOURCE_CUSTOM_TYPE
        ) {
          newestCreationSourceEntry = parsed;
        }
        if (parsed.type === "session_info") {
          name = normalizedSessionName(parsed.name);
        }
        if (parsed.type !== "message") continue;

        messageCount += 1;
        const message = sessionMessage(parsed.message);
        if (message === undefined) continue;
        const activityTime = sessionMessageActivityTime(
          parsed.timestamp,
          message
        );
        if (activityTime !== undefined) {
          lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
        }
        if (
          message.role !== "user" &&
          message.role !== "assistant"
        ) {
          continue;
        }
        if (message.text === "") continue;
        allMessages.push(message.text);
        if (firstMessage === "" && message.role === "user") {
          firstMessage = message.text;
        }
      }
    }

    if (header === undefined) return undefined;
    const headerTimestamp = header.timestamp;
    const headerTime = new Date(headerTimestamp).getTime();
    const sourceInspection = inspectSessionCreationSource(
      newestCreationSourceEntry === undefined
        ? []
        : [newestCreationSourceEntry]
    );
    const cwd =
      typeof header.cwd === "string"
        ? canonicalizeStoredCwd(header.cwd)
        : "";
    const parentSessionPath =
      typeof header.parentSession === "string"
        ? header.parentSession
        : undefined;

    return {
      path,
      id: header.id,
      cwd,
      ...(name === undefined ? {} : { name }),
      ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
      created: new Date(headerTimestamp),
      modified:
        lastActivityTime !== undefined && lastActivityTime > 0
          ? new Date(lastActivityTime)
          : !Number.isNaN(headerTime)
          ? new Date(headerTime)
          : stats.mtime,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      allMessagesText: allMessages.join(" "),
      ...(sourceInspection.kind === "valid"
        ? { creationSource: sourceInspection.source }
        : {}),
    };
  } catch {
    return undefined;
  }
}

interface ParsedSessionMessage {
  role: string;
  text: string;
  timestamp?: number;
}

function sessionMessage(value: unknown): ParsedSessionMessage | undefined {
  if (!isRecord(value)) return undefined;
  const { content, role, timestamp } = value;
  if (typeof role !== "string") return undefined;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .flatMap((block) => {
        if (!isRecord(block)) return [];
        const { text: blockText, type } = block;
        return type === "text" && typeof blockText === "string"
          ? [blockText]
          : [];
      })
      .join(" ");
  } else {
    return undefined;
  }
  return {
    role,
    text,
    ...(typeof timestamp === "number" ? { timestamp } : {}),
  };
}

function sessionMessageActivityTime(
  entryTimestamp: unknown,
  message: ParsedSessionMessage
): number | undefined {
  if (message.role !== "user" && message.role !== "assistant") {
    return undefined;
  }
  if (message.timestamp !== undefined) return message.timestamp;
  if (typeof entryTimestamp !== "string") return undefined;
  const timestamp = new Date(entryTimestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function normalizedSessionName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function listSessionsInDefaultPiStore(storeRoot: string): Promise<PiSessionListEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(storeRoot, entry.name));
  const sessions = (await Promise.all(sessionDirs.map((dir) => listSessionsInDir(dir)))).flat();
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function filterSessionsForCwd(sessions: readonly PiSessionListEntry[], cwd: string): PiSessionListEntry[] {
  // Sessions with an empty cwd (old session files) are excluded: resolve("") would
  // resolve to this process's cwd and produce false matches.
  return sessions.filter((session) => session.cwd !== "" && cwdPathsEqual(session.cwd, cwd));
}

function uniqueSessionsByPath(sessions: readonly PiSessionListEntry[]): PiSessionListEntry[] {
  const byPath = new Map<string, PiSessionListEntry>();
  for (const session of sessions) byPath.set(session.path, session);
  return [...byPath.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function defaultPiSessionsRoot(agentDir: string): string {
  return join(agentDir, "sessions");
}

export function defaultPiSessionDir(cwd: string, agentDir: string): string {
  return sessionDirInDefaultPiStore(defaultPiSessionsRoot(agentDir), cwd);
}

export function sessionDirInDefaultPiStore(storeRoot: string, cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  return join(storeRoot, safePath);
}

export function resolveConfiguredPath(path: string, cwd: string, homeDir: string): string {
  const expanded = expandTildePath(path, homeDir);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function expandTildePath(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}
