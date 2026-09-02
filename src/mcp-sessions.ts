export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export type McpSessionRegistryState = "running" | "closing" | "closed";

export type McpSessionDisposeReason =
  | "transport_close"
  | "capacity_eviction"
  | "idle_timeout"
  | "server_shutdown"
  | "initialize_failure";

export type McpSessionAdmissionFailure = "capacity" | "closing";

export interface McpSessionOperationContext {
  requestId?: string;
}

export interface McpSessionReservation {
  readonly token: number;
}

export interface McpSessionLease<TTransport> {
  readonly token: number;
  readonly sessionId: string;
  readonly transport: TTransport;
}

export interface McpSessionRegistrySnapshot {
  state: McpSessionRegistryState;
  current: number;
  active: number;
  pendingReservations: number;
  max: number;
  createdTotal: number;
  closedTotal: number;
  evictedTotal: number;
  closeErrorTotal: number;
  capacityRejectedTotal: number;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

export interface McpSessionLifecycleEvent {
  type: "created" | "closed" | "evicted" | "capacity_rejected" | "close_failed";
  sessionId?: string;
  reason?: McpSessionDisposeReason;
  requestId?: string;
  snapshot: McpSessionRegistrySnapshot;
}

export class McpSessionAdmissionError extends Error {
  constructor(readonly reason: McpSessionAdmissionFailure) {
    super(
      reason === "capacity"
        ? "MCP session capacity exhausted"
        : "MCP session registry is closing",
    );
  }
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  idleSince: number | undefined;
  inFlight: number;
  disposing: boolean;
}

interface DetachedSession<TTransport> {
  sessionId: string;
  transport: TTransport;
  reason: McpSessionDisposeReason;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  maxSessions?: number;
  waitForTimeout?: (ms: number) => Promise<void>;
  onEvent?: (event: McpSessionLifecycleEvent) => void;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly reservations = new Set<number>();
  private readonly leases = new Map<number, string>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly onEvent?: (event: McpSessionLifecycleEvent) => void;
  private state: McpSessionRegistryState = "running";
  private nextReservationToken = 1;
  private nextLeaseToken = 1;
  private createdTotal = 0;
  private closedTotal = 0;
  private evictedTotal = 0;
  private closeErrorTotal = 0;
  private capacityRejectedTotal = 0;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? 64;
    this.onEvent = options.onEvent;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new Error("MCP session max must be a positive integer");
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  snapshot(): McpSessionRegistrySnapshot {
    let active = 0;
    for (const entry of this.sessions.values()) {
      if (entry.inFlight > 0) active += 1;
    }
    return {
      state: this.state,
      current: this.sessions.size,
      active,
      pendingReservations: this.reservations.size,
      max: this.maxSessions,
      createdTotal: this.createdTotal,
      closedTotal: this.closedTotal,
      evictedTotal: this.evictedTotal,
      closeErrorTotal: this.closeErrorTotal,
      capacityRejectedTotal: this.capacityRejectedTotal,
    };
  }

  async reserve(
    context: McpSessionOperationContext = {},
  ): Promise<McpSessionReservation> {
    if (this.state !== "running") {
      throw new McpSessionAdmissionError("closing");
    }

    let detached: DetachedSession<TTransport> | undefined;
    if (this.sessions.size + this.reservations.size >= this.maxSessions) {
      const oldestIdle = this.oldestIdleSession();
      if (!oldestIdle) {
        this.capacityRejectedTotal += 1;
        this.emit({
          type: "capacity_rejected",
          requestId: context.requestId,
        });
        throw new McpSessionAdmissionError("capacity");
      }
      detached = this.detach(oldestIdle.sessionId, "capacity_eviction");
    }

    const token = this.nextReservationToken++;
    this.reservations.add(token);

    if (detached) await this.closeDetached(detached, context);
    if (this.state !== "running" || !this.reservations.has(token)) {
      this.reservations.delete(token);
      throw new McpSessionAdmissionError("closing");
    }
    return { token };
  }

  async commit(
    reservation: McpSessionReservation,
    sessionId: string,
    transport: TTransport,
    context: McpSessionOperationContext = {},
  ): Promise<McpSessionLease<TTransport> | false> {
    const reserved = this.reservations.delete(reservation.token);
    if (!reserved) {
      await this.closeUncommitted(transport, context);
      if (this.state !== "running") return false;
      throw new Error("Unknown or already-consumed MCP session reservation");
    }

    if (this.state !== "running") {
      await this.closeUncommitted(transport, context);
      return false;
    }

    if (this.sessions.has(sessionId)) {
      await this.closeUncommitted(transport, context);
      throw new Error("Duplicate MCP session ID");
    }

    const leaseToken = this.nextLeaseToken++;
    this.sessions.set(sessionId, {
      transport,
      idleSince: undefined,
      inFlight: 1,
      disposing: false,
    });
    this.leases.set(leaseToken, sessionId);
    this.createdTotal += 1;
    this.emit({
      type: "created",
      sessionId,
      requestId: context.requestId,
    });
    return { token: leaseToken, sessionId, transport };
  }

  cancel(reservation: McpSessionReservation): boolean {
    return this.reservations.delete(reservation.token);
  }

  release(lease: McpSessionLease<TTransport>): boolean {
    const sessionId = this.leases.get(lease.token);
    if (sessionId === undefined) return false;
    this.leases.delete(lease.token);

    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (entry.inFlight <= 0) return false;

    entry.inFlight -= 1;
    if (entry.inFlight === 0) entry.idleSince = this.now();
    return true;
  }

  // Compatibility surface retained only until server wiring migrates to the
  // reservation/lease API in a later plan task.
  register(sessionId: string, transport: TTransport): void {
    if (this.state !== "running") {
      throw new McpSessionAdmissionError("closing");
    }
    this.sessions.set(sessionId, {
      transport,
      idleSince: this.now(),
      inFlight: 0,
      disposing: false,
    });
  }

  get(sessionId: string): TTransport | undefined {
    if (this.state !== "running") return undefined;
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.disposing) return undefined;
    entry.idleSince = this.now();
    return entry.transport;
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const detached: DetachedSession<TTransport>[] = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.inFlight !== 0 || entry.idleSince === undefined) continue;
      if (entry.idleSince > cutoff) continue;
      const removed = this.detach(sessionId, "idle_timeout");
      if (removed) detached.push(removed);
    }

    return Promise.all(detached.map((session) => this.closeDetached(session)));
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    if (this.state === "closed") return [];
    this.state = "closing";
    this.reservations.clear();

    const detached: DetachedSession<TTransport>[] = [];
    for (const sessionId of [...this.sessions.keys()]) {
      const removed = this.detach(sessionId, "server_shutdown");
      if (removed) detached.push(removed);
    }
    this.leases.clear();

    const results = await Promise.all(
      detached.map((session) => this.closeDetached(session)),
    );
    this.state = "closed";
    return results;
  }

  private oldestIdleSession(): { sessionId: string; idleSince: number } | undefined {
    let oldest: { sessionId: string; idleSince: number } | undefined;
    for (const [sessionId, entry] of this.sessions) {
      if (entry.inFlight !== 0 || entry.idleSince === undefined || entry.disposing) {
        continue;
      }
      if (!oldest || entry.idleSince < oldest.idleSince) {
        oldest = { sessionId, idleSince: entry.idleSince };
      }
    }
    return oldest;
  }

  private detach(
    sessionId: string,
    reason: McpSessionDisposeReason,
  ): DetachedSession<TTransport> | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.disposing) return undefined;
    entry.disposing = true;
    this.sessions.delete(sessionId);
    for (const [leaseToken, leasedSessionId] of this.leases) {
      if (leasedSessionId === sessionId) this.leases.delete(leaseToken);
    }
    if (reason === "capacity_eviction") {
      this.evictedTotal += 1;
      this.emit({ type: "evicted", sessionId, reason });
    }
    return { sessionId, transport: entry.transport, reason };
  }

  private async closeDetached(
    detached: DetachedSession<TTransport>,
    context: McpSessionOperationContext = {},
  ): Promise<McpSessionCloseResult> {
    try {
      await detached.transport.close();
      this.closedTotal += 1;
      this.emit({
        type: "closed",
        sessionId: detached.sessionId,
        reason: detached.reason,
        requestId: context.requestId,
      });
      return { sessionId: detached.sessionId };
    } catch (error) {
      this.closeErrorTotal += 1;
      this.emit({
        type: "close_failed",
        sessionId: detached.sessionId,
        reason: detached.reason,
        requestId: context.requestId,
      });
      return { sessionId: detached.sessionId, error };
    }
  }

  private async closeUncommitted(
    transport: TTransport,
    context: McpSessionOperationContext,
  ): Promise<void> {
    try {
      await transport.close();
    } catch {
      this.closeErrorTotal += 1;
      this.emit({
        type: "close_failed",
        requestId: context.requestId,
      });
    }
  }

  private emit(
    event: Omit<McpSessionLifecycleEvent, "snapshot">,
  ): void {
    this.onEvent?.({ ...event, snapshot: this.snapshot() });
  }
}
