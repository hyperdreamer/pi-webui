/**
 * One replaceable unit of selection-driven loading.
 *
 * Selecting another project, workspace, or session abandons the previous
 * selection's reads, but an in-flight `fetch` cannot be abandoned by identity
 * checks alone: the response still arrives, is buffered, and is parsed before a
 * guard can discard it. Switching quickly therefore paid for every selection the
 * user had already left. A scope owns the current load's `AbortSignal` so the
 * previous one can be cancelled at the transport instead.
 *
 * The signal complements, and does not replace, the existing generation and
 * identity guards: a request that wins the abort race must still be prevented
 * from publishing state, which is what those guards do.
 */
export class CancellableLoadScope {
  private controller: AbortController | undefined;

  /**
   * The open load's signal, or `undefined` when nothing is loading. Read this
   * per attempt rather than capturing it: a retried or trailing pass belongs to
   * whichever load is open when it runs, and reusing an aborted signal would
   * cancel the new selection's work.
   */
  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  /** Abort the open load, if any, and open a replacement. */
  restart(): AbortSignal {
    this.abort();
    const controller = new AbortController();
    this.controller = controller;
    return controller.signal;
  }

  /** Abort the open load without opening a replacement. */
  abort(): void {
    const controller = this.controller;
    if (controller === undefined) return;
    this.controller = undefined;
    controller.abort(new LoadCancelledError());
  }
}

/** Marker for a load abandoned because its selection was superseded. */
export class LoadCancelledError extends Error {
  constructor() {
    super("Load cancelled because the selection changed");
    this.name = "LoadCancelledError";
  }
}

/**
 * Whether a rejection means "superseded", not "failed". Supersession is the
 * expected outcome of switching and must never surface as a user-visible error.
 * Covers both this module's marker and the `AbortError` that `fetch` rejects
 * with when its signal aborts.
 */
export function isLoadCancellation(reason: unknown): boolean {
  if (reason instanceof LoadCancelledError) return true;
  return isNamed(reason) && reason.name === "AbortError";
}

function isNamed(value: unknown): value is { name: unknown } {
  return typeof value === "object" && value !== null && "name" in value;
}
