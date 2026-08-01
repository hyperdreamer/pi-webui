import type { GlobalSessionEvent, RealtimeEvent, SessionNotificationSummaryEvent, SessionUiEvent } from "../../shared/apiTypes.js";
import { projectBrowserSessionEvent } from "../browserMessageProjection.js";
import { SessionStatusCoalescer, isImmediateActivityUpdate, isImmediateStatusUpdate } from "./sessionStatusCoalescer.js";

export interface RealtimeSocket {
  readonly OPEN: number;
  readyState: number;
  send(payload: string): void;
  terminate(): void;
  on(event: "close", listener: () => void): unknown;
}

export interface SessionEventHubOptions {
  intervalMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

type CoalescableEvent = Extract<SessionUiEvent, { type: "status.update" | "activity.update" }>;

export class SessionEventHub {
  private readonly socketsBySession = new Map<string, Set<RealtimeSocket>>();
  private readonly globalSockets = new Set<RealtimeSocket>();
  private readonly seqBySession = new Map<string, number>();
  private readonly sessionStatusCoalescer: SessionStatusCoalescer<CoalescableEvent>;
  private readonly globalStatusCoalescer: SessionStatusCoalescer<CoalescableEvent>;

  constructor(options: SessionEventHubOptions = {}) {
    this.sessionStatusCoalescer = new SessionStatusCoalescer(isImmediateCoalescableEvent, options);
    this.globalStatusCoalescer = new SessionStatusCoalescer(isImmediateCoalescableEvent, options);
  }

  add(sessionId: string, socket: RealtimeSocket): void {
    let sockets = this.socketsBySession.get(sessionId);
    if (!sockets) {
      sockets = new Set();
      this.socketsBySession.set(sessionId, sockets);
    }
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  }

  addGlobal(socket: RealtimeSocket): void {
    this.globalSockets.add(socket);
    socket.on("close", () => this.globalSockets.delete(socket));
  }

  publish(sessionId: string, event: SessionUiEvent): void {
    if (isCoalescableSessionEvent(event)) {
      this.sessionStatusCoalescer.publish(`${sessionId}:${event.type}`, event, (latest) => {
        this.sendSessionEvent(sessionId, latest);
      });
      return;
    }
    this.sendSessionEvent(sessionId, event);
  }

  /**
   * Last per-session sequence number stamped by {@link publish} (0 before any
   * event). Callers building a join-time stream snapshot read this as the
   * watermark: buffered live events with `seq <= currentSeq` are already
   * reflected in the snapshot's partial and must be dropped by the client.
   */
  currentSeq(sessionId: string): number {
    return this.seqBySession.get(sessionId) ?? 0;
  }

  publishGlobal(event: GlobalSessionEvent): void {
    this.publishRealtime(event);
  }

  publishNotificationSummary(event: SessionNotificationSummaryEvent): void {
    const payload = JSON.stringify(event);
    this.sendToSockets(this.globalSockets, payload);
  }

  publishRealtime(event: RealtimeEvent): void {
    if (isCoalescableRealtimeEvent(event)) {
      const sessionId = event.type === "status.update" ? event.status.sessionId : event.activity.sessionId;
      this.globalStatusCoalescer.publish(`global:${event.type}:${sessionId}`, event, (latest) => {
        this.sendRealtimeEvent(latest);
      });
      return;
    }
    this.sendRealtimeEvent(event);
  }

  private sendSessionEvent(sessionId: string, event: SessionUiEvent): void {
    const seq = (this.seqBySession.get(sessionId) ?? 0) + 1;
    this.seqBySession.set(sessionId, seq);
    const payload = JSON.stringify({ ...projectBrowserSessionEvent(event), seq });
    this.sendToSockets(this.socketsBySession.get(sessionId), payload);
  }

  private sendRealtimeEvent(event: RealtimeEvent): void {
    const payload = JSON.stringify(event);
    this.sendToSockets(this.globalSockets, payload);
  }

  private sendToSockets(sockets: Set<RealtimeSocket> | undefined, payload: string): void {
    if (sockets === undefined) return;
    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        sockets.delete(socket);
        try {
          socket.terminate();
        } catch {
          // Removal is authoritative; cleanup failure must not block healthy sockets.
        }
      }
    }
  }
}

function isCoalescableSessionEvent(event: SessionUiEvent): event is CoalescableEvent {
  return event.type === "status.update" || event.type === "activity.update";
}

function isCoalescableRealtimeEvent(event: RealtimeEvent): event is CoalescableEvent {
  return event.type === "status.update" || event.type === "activity.update";
}

function isImmediateCoalescableEvent(previous: CoalescableEvent, next: CoalescableEvent): boolean {
  if (previous.type === "status.update" && next.type === "status.update") return isImmediateStatusUpdate(previous.status, next.status);
  if (previous.type === "activity.update" && next.type === "activity.update") return isImmediateActivityUpdate(previous.activity, next.activity);
  return true;
}
