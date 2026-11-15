import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { traceEvents, type Database, type TraceEvent, type TraceOutcome } from "@gatekeeper/database";
import { newId } from "./ids";
import { logger } from "./logger";
import { redact } from "./redact";

export interface TraceContext {
  correlationId: string;
  sessionId?: string | null;
  actorId?: string | null;
}

export interface TraceEventInput {
  name?: string;
  outcome?: TraceOutcome;
  durationMs?: number;
  attributes?: Record<string, unknown>;
}

/**
 * Lightweight diagnostic tracer. Events are persisted for the execution viewer and
 * mirrored to structured logs. Attributes are redacted before they are stored.
 */
export class Tracer {
  constructor(
    private readonly db: Database,
    readonly context: TraceContext,
  ) {}

  event(type: string, input: TraceEventInput = {}): void {
    const row = {
      id: newId("trc"),
      timestamp: new Date().toISOString(),
      correlationId: this.context.correlationId,
      sessionId: this.context.sessionId ?? null,
      actorId: this.context.actorId ?? null,
      type,
      name: input.name ?? null,
      outcome: input.outcome ?? "info",
      durationMs: input.durationMs === undefined ? null : Math.round(input.durationMs),
      attributes: input.attributes ? JSON.stringify(redact(input.attributes)) : null,
    };
    try {
      this.db.insert(traceEvents).values(row).run();
    } catch (error) {
      // Diagnostics must never break the request they describe.
      logger.warn("trace.persist_failed", { error: String(error) });
    }
    logger.debug("trace", { type, name: row.name, outcome: row.outcome, correlationId: row.correlationId });
  }

  child(overrides: Partial<TraceContext>): Tracer {
    return new Tracer(this.db, { ...this.context, ...overrides });
  }
}

export interface TraceFilter {
  actorIds?: string[];
  correlationId?: string;
  outcome?: TraceOutcome;
  limit?: number;
}

export function listTraceEvents(db: Database, filter: TraceFilter = {}): TraceEvent[] {
  const conditions: SQL[] = [];
  if (filter.actorIds) conditions.push(inArray(traceEvents.actorId, filter.actorIds));
  if (filter.correlationId) conditions.push(eq(traceEvents.correlationId, filter.correlationId));
  if (filter.outcome) conditions.push(eq(traceEvents.outcome, filter.outcome));
  return db
    .select()
    .from(traceEvents)
    .where(and(...conditions))
    .orderBy(sql`${traceEvents}.rowid desc`)
    .limit(Math.min(filter.limit ?? 300, 1000))
    .all();
}

export function listTraceForCorrelation(db: Database, correlationId: string): TraceEvent[] {
  return db
    .select()
    .from(traceEvents)
    .where(eq(traceEvents.correlationId, correlationId))
    .orderBy(sql`${traceEvents}.rowid asc`)
    .all();
}
