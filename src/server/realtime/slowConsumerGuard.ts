/**
 * Evidence for the production defaults:
 * Primary 60 s sample: global peak 57,922 B/s, session peak 25,514 B/s, join peak 28,931 B/s.
 * Independent reviewer follow-up: global peak 121,985 B/s.
 * 4,000,000 bytes is 32.8x the highest observed 121,985 B/s peak and remains far below the 125.9 MB incident queue.
 * 5,000 ms is 50x the 100 ms SessionStatusCoalescer interval and tolerates transient tab/render stalls.
 */
export const SLOW_CONSUMER_SOFT_LIMIT_BYTES = 4_000_000;
export const SLOW_CONSUMER_STALL_WINDOW_MS = 5_000;

export interface GuardedSocket {
  bufferedAmount: number;
  terminate(): void;
}

export interface SlowConsumerGuardOptions {
  softLimitBytes?: number;
  stallWindowMs?: number;
  now?: () => number;
  onTerminate?: (info: { bufferedAmount: number; stalledForMs: number }) => void;
}

/**
 * Kills a websocket whose kernel buffer stays deep without draining. A socket
 * is terminated only when `bufferedAmount` exceeds the soft limit and has not
 * dropped below its high-water mark for `stallWindowMs`; any observed decrease
 * (or return at/below the soft limit) resets the mark and the stall clock, so
 * a deep-but-draining consumer survives.
 */
export class SlowConsumerGuard {
  private readonly softLimitBytes: number;
  private readonly stallWindowMs: number;
  private readonly now: () => number;
  private readonly onTerminate: ((info: { bufferedAmount: number; stalledForMs: number }) => void) | undefined;
  private highWaterMark = 0;
  private highWaterSinceMs = 0;
  private _terminated = false;

  constructor(
    private readonly socket: GuardedSocket,
    options: SlowConsumerGuardOptions = {},
  ) {
    this.softLimitBytes = options.softLimitBytes ?? SLOW_CONSUMER_SOFT_LIMIT_BYTES;
    this.stallWindowMs = options.stallWindowMs ?? SLOW_CONSUMER_STALL_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.onTerminate = options.onTerminate;
  }

  /** Call immediately after every send. Returns true if the socket was terminated. */
  afterSend(): boolean {
    if (this._terminated) return true;
    const now = this.now();
    const bufferedAmount = this.socket.bufferedAmount;

    // Drained back to (or below) the soft limit, or dropped below the running
    // high-water mark: the consumer is making progress, so restart the stall
    // window from the newly observed depth.
    if (bufferedAmount <= this.softLimitBytes || bufferedAmount < this.highWaterMark) {
      this.highWaterMark = bufferedAmount;
      this.highWaterSinceMs = now;
      return false;
    }

    // Depth is above the soft limit and not draining. The stall clock is
    // measured from the first observation of the current high-water regime;
    // a rising buffer raises the mark without restarting the clock, so a
    // monotonic climb still times out.
    if (now - this.highWaterSinceMs >= this.stallWindowMs) {
      this._terminated = true;
      try {
        this.socket.terminate();
      } catch {
        // The socket may already be gone; the terminated flag is authoritative.
      }
      this.onTerminate?.({ bufferedAmount, stalledForMs: now - this.highWaterSinceMs });
      return true;
    }

    if (bufferedAmount > this.highWaterMark) {
      this.highWaterMark = bufferedAmount;
    }
    return false;
  }

  get terminated(): boolean {
    return this._terminated;
  }
}
