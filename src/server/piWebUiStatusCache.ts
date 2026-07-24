import type { PiWebUiStatusResponse } from "../shared/apiTypes.js";

const DEFAULT_PI_WEBUI_STATUS_CACHE_TTL_MS = 60_000;

export interface PiWebUiStatusCacheOptions {
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface PiWebUiStatusCacheLoadOptions {
  force: boolean;
}

export interface PiWebUiStatusCacheRefreshOptions {
  force?: boolean;
}

export interface PiWebUiStatusCache {
  get(): Promise<PiWebUiStatusResponse>;
  refresh(options?: PiWebUiStatusCacheRefreshOptions): Promise<PiWebUiStatusResponse>;
  invalidate(): void;
}

export function createPiWebUiStatusCache(load: (options: PiWebUiStatusCacheLoadOptions) => Promise<PiWebUiStatusResponse>, options: PiWebUiStatusCacheOptions = {}): PiWebUiStatusCache {
  const ttlMs = options.ttlMs ?? DEFAULT_PI_WEBUI_STATUS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { status: PiWebUiStatusResponse; expiresAt: number } | undefined;
  let pending: { promise: Promise<PiWebUiStatusResponse>; force: boolean; sequence: number } | undefined;
  let loadSequence = 0;

  const refresh = (refreshOptions: PiWebUiStatusCacheRefreshOptions = {}): Promise<PiWebUiStatusResponse> => {
    const force = refreshOptions.force === true;
    if (pending !== undefined && (!force || pending.force)) return pending.promise;

    const sequence = ++loadSequence;
    const promise = Promise.resolve()
      .then(() => load({ force }))
      .then((status) => {
        if (sequence === loadSequence) cached = { status, expiresAt: now() + ttlMs };
        return status;
      })
      .finally(() => {
        if (pending?.sequence === sequence) pending = undefined;
      });
    pending = { promise, force, sequence };
    return promise;
  };

  return {
    async get(): Promise<PiWebUiStatusResponse> {
      if (cached !== undefined) {
        if (cached.expiresAt > now()) return cached.status;
        void refresh().catch((error: unknown) => { options.onError?.(error); });
        return cached.status;
      }
      return refresh();
    },
    refresh,
    invalidate(): void {
      cached = undefined;
      loadSequence += 1;
      pending = undefined;
    },
  };
}
