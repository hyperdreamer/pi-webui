interface PendingRefresh {
  promise: Promise<void>;
  latestRefresh: () => Promise<void>;
  started: boolean;
  trailing: boolean;
}

/**
 * Shares refresh work requested in the same task and collapses requests made
 * during an active refresh into one trailing pass, without losing later passes.
 */
export class TrailingRefreshCoordinator<Key> {
  private readonly pendingByKey = new Map<Key, PendingRefresh>();

  request(key: Key, refresh: () => Promise<void>): Promise<void> {
    const existing = this.pendingByKey.get(key);
    if (existing !== undefined) {
      existing.latestRefresh = refresh;
      if (existing.started) existing.trailing = true;
      return existing.promise;
    }

    const pending: PendingRefresh = {
      promise: Promise.resolve(),
      latestRefresh: refresh,
      started: false,
      trailing: false,
    };
    pending.promise = Promise.resolve()
      .then(async () => {
        let latestError: unknown;
        let latestFailed: boolean;
        do {
          pending.trailing = false;
          const runRefresh = pending.latestRefresh;
          pending.started = true;
          latestFailed = false;
          try {
            await runRefresh();
          } catch (error) {
            latestError = error;
            latestFailed = true;
          }
        } while (this.hasTrailingRequest(pending));
        if (latestFailed) throw latestError;
      })
      .finally(() => {
        if (this.pendingByKey.get(key) === pending) this.pendingByKey.delete(key);
      });
    this.pendingByKey.set(key, pending);
    return pending.promise;
  }

  private hasTrailingRequest(pending: PendingRefresh): boolean {
    return pending.trailing;
  }
}
