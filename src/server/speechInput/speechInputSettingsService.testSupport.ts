import { PiWebUiConfigMutationBusyError, type PiWebUiConfigMutationCoordinator, type PiWebUiConfigMutationSnapshot } from "../../configMutationCoordinator.js";
import type { LoadedPiWebUiConfig } from "../../config.js";
import type { PiWebUiConfigValues } from "../../shared/apiTypes.js";

/**
 * Canonical lowercase v4-shaped UUID revisions for deterministic speech
 * settings tests. Sequence 1 is the seeded revision; rotations advance.
 */
export const SPEECH_INPUT_TEST_REVISION = "00000000-0000-4000-8000-000000000001";

export function testSpeechInputRevision(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

export interface InMemorySpeechInputConfigCoordinator extends PiWebUiConfigMutationCoordinator {
  /** The current committed snapshot, for assertions and state inspection. */
  current(): PiWebUiConfigMutationSnapshot;
  /** How many coordinated mutations have entered the transaction. */
  mutateCalls(): number;
  /** When busy, every read/mutate rejects with the typed contention failure. */
  setBusy(busy: boolean): void;
}

export interface InMemorySpeechInputConfigCoordinatorOptions {
  config?: PiWebUiConfigValues;
  revision?: string;
  createRevision?: () => string;
}

/**
 * In-memory full-fidelity config mutation coordinator for speech settings
 * tests. It mirrors the production coordinator's observable contract: mutate
 * applies the callback to the committed config, persists the returned values,
 * and rotates the speech revision when requested or when the raw speechInput
 * subtree changed. Unrelated coordinated writes preserve the revision.
 */
export function createInMemorySpeechInputConfigCoordinator(options: InMemorySpeechInputConfigCoordinatorOptions = {}): InMemorySpeechInputConfigCoordinator {
  let revisionSequence = 2;
  const createRevision = options.createRevision ?? (() => testSpeechInputRevision(revisionSequence++));
  let loaded: LoadedPiWebUiConfig = {
    path: "/test/pi-webui/config.json",
    exists: true,
    config: options.config ?? {},
  };
  let speechInputRevision = options.revision ?? SPEECH_INPUT_TEST_REVISION;
  let busy = false;
  let mutations = 0;

  return {
    current: () => ({ loaded, speechInputRevision }),
    mutateCalls: () => mutations,
    setBusy: (next) => {
      busy = next;
    },
    read: () => {
      if (busy) return Promise.reject(new PiWebUiConfigMutationBusyError());
      return Promise.resolve({ loaded, speechInputRevision });
    },
    mutate: (mutate, mutationOptions = {}) => {
      if (busy) return Promise.reject(new PiWebUiConfigMutationBusyError());
      mutations += 1;
      const before = { loaded, speechInputRevision };
      const next = mutate(before);
      const speechChanged = !sameSpeechInputSubtree(loaded.config.speechInput, next.speechInput);
      const rotate = speechChanged || mutationOptions.rotateSpeechInputRevision === true;
      loaded = { ...loaded, config: next };
      speechInputRevision = rotate ? createRevision() : speechInputRevision;
      return Promise.resolve({ loaded, speechInputRevision });
    },
  };
}

/**
 * Field-by-field structural equality of speech subtrees, order-independent
 * and tolerant of unknown keys, matching the production coordinator's
 * conservative raw-persisted comparison.
 */
function sameSpeechInputSubtree(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRawRecord(a) || !isRawRecord(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!sameSpeechInputSubtree(a[key], b[key])) return false;
  }
  return true;
}

function isRawRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
