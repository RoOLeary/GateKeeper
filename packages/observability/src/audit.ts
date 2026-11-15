import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { auditEvents, type AuditDecision, type AuditEvent, type Database, type DbExecutor } from "@gatekeeper/database";
import { newId } from "./ids";
import { logger } from "./logger";
import { redact } from "./redact";

export type Channel = "web" | "mcp" | "mcp-stdio" | "system";

export interface AuditInput {
  actor: { id: string; role: string } | null;
  action: string;
  resourceType?: string;
  resourceId?: string | number;
  decision: AuditDecision;
  reason?: string;
  correlationId: string;
  channel: Channel;
  metadata?: Record<string, unknown>;
}

/** Appends a security audit event. Audit events are immutable once written. */
export function recordAudit(db: DbExecutor, input: AuditInput): AuditEvent {
  const row = {
    id: newId("aud"),
    timestamp: new Date().toISOString(),
    actorId: input.actor?.id ?? null,
    actorRole: input.actor?.role ?? null,
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId === undefined ? null : String(input.resourceId),
    decision: input.decision,
    reason: input.reason ?? null,
    correlationId: input.correlationId,
    channel: input.channel,
    metadata: input.metadata ? JSON.stringify(redact(input.metadata)) : null,
  };
  db.insert(auditEvents).values(row).run();
  logger.info("audit", {
    action: row.action,
    decision: row.decision,
    actorId: row.actorId,
    resource: row.resourceType ? `${row.resourceType}:${row.resourceId}` : undefined,
    correlationId: row.correlationId,
  });
  return row;
}

export interface AuditFilter {
  /** Restrict to events performed by these actors. `undefined` means unrestricted. */
  actorIds?: string[];
  /** Match events touching any of these resources. */
  resources?: Array<{ type: string; id: string }>;
  correlationId?: string;
  decision?: AuditDecision;
  limit?: number;
}

export function listAuditEvents(db: Database, filter: AuditFilter = {}): AuditEvent[] {
  const conditions: SQL[] = [];
  if (filter.actorIds) conditions.push(inArray(auditEvents.actorId, filter.actorIds));
  if (filter.resources) {
    if (filter.resources.length === 0) return [];
    conditions.push(
      or(
        ...filter.resources.map((r) => and(eq(auditEvents.resourceType, r.type), eq(auditEvents.resourceId, r.id))),
      )!,
    );
  }
  if (filter.correlationId) conditions.push(eq(auditEvents.correlationId, filter.correlationId));
  if (filter.decision) conditions.push(eq(auditEvents.decision, filter.decision));
  return db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(sql`${auditEvents}.rowid desc`)
    .limit(Math.min(filter.limit ?? 100, 500))
    .all();
}
