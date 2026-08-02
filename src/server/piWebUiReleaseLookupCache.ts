const DEFAULT_PI_WEBUI_RELEASE_LOOKUP_CACHE_TTL_MS = 15 * 60 * 1000;

export interface PiWebUiReleaseLookup {
  checkedAtMs: number;
  latestVersion?: string;
  error?: string;
}

export interface PiWebUiReleaseLookupCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

export interface PiWebUiReleaseLookupOptions {
  force?: boolean;
}

export interface PiWebUiReleaseLookupCache {
  get(currentVersion: string, options?: PiWebUiReleaseLookupOptions): Promise<PiWebUiReleaseLookup>;
}

export function createPiWebUiReleaseLookupCache(
  load: (currentVersion: string) => Promise<string>,
  options: PiWebUiReleaseLookupCacheOptions = {},
): PiWebUiReleaseLookupCache {
  const ttlMs = options.ttlMs ?? DEFAULT_PI_WEBUI_RELEASE_LOOKUP_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: PiWebUiReleaseLookup | undefined;
  let pending: { promise: Promise<PiWebUiReleaseLookup>; force: boolean; sequence: number } | undefined;
  let loadSequence = 0;

  return {
    get(currentVersion: string, lookupOptions: PiWebUiReleaseLookupOptions = {}): Promise<PiWebUiReleaseLookup> {
      const force = lookupOptions.force === true;
      if (pending?.force === true) return pending.promise;

      const checkedAtMs = now();
      if (!force && cached !== undefined && checkedAtMs - cached.checkedAtMs < ttlMs) return Promise.resolve(cached);
      if (!force && pending !== undefined) return pending.promise;

      const sequence = ++loadSequence;
      const promise = Promise.resolve()
        .then(() => load(currentVersion))
        .then((latestVersion): PiWebUiReleaseLookup => ({ checkedAtMs, latestVersion }))
        .catch((error: unknown): PiWebUiReleaseLookup => ({ checkedAtMs, error: error instanceof Error ? error.message : String(error) }))
        .then((lookup) => {
          if (sequence === loadSequence) cached = lookup;
          return lookup;
        })
        .finally(() => {
          if (pending?.sequence === sequence) pending = undefined;
        });
      pending = { promise, force, sequence };
      return promise;
    },
  };
}
