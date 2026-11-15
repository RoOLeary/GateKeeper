import { eq, inArray } from "drizzle-orm";
import { approvalRequests, orders, users, type TraceOutcome } from "@gatekeeper/database";
import { listAuditEvents, listTraceEvents } from "@gatekeeper/observability";
import { enforce, notFound, parseInput, requireActor } from "../authorization/enforce";
import type { Actor, ExecutionContext } from "../context";
import { GetAuditHistoryInput } from "../schemas";
import { loadCustomer, loadOrder, orderFacts } from "./resources";

export type VisibilityScope = "all" | "team" | "own";

/** Whose events an actor may see. `actorIds: undefined` means unrestricted. */
export function eventVisibility(ctx: ExecutionContext, actor: Actor): { scope: VisibilityScope; actorIds?: string[] } {
  if (actor.role === "admin") return { scope: "all" };
  if (actor.role === "manager" && actor.teamId) {
    const team = ctx.db.select({ id: users.id }).from(users).where(eq(users.teamId, actor.teamId)).all();
    return { scope: "team", actorIds: team.map((u) => u.id) };
  }
  return { scope: "own", actorIds: [actor.id] };
}

export interface AuditEventView {
  id: string;
  timestamp: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  resource: string | null;
  decision: string;
  reason: string | null;
  correlationId: string;
  channel: string;
  metadata: Record<string, unknown> | null;
}

export interface AuditHistoryResult {
  visibility: VisibilityScope;
  note: string;
  events: AuditEventView[];
}

const VISIBILITY_NOTES: Record<VisibilityScope, string> = {
  all: "Full audit history (administrator).",
  team: "Audit history for actions taken by members of your team.",
  own: "Support agents can only see audit events for their own actions.",
};

export function getAuditHistory(ctx: ExecutionContext, raw: unknown): AuditHistoryResult {
  requireActor(ctx, "audit.read");
  const input = parseInput(ctx, "audit.read", GetAuditHistoryInput, raw);

  let resources: Array<{ type: string; id: string }> | undefined;
  if (input.orderId !== undefined) {
    const found = loadOrder(ctx.db, input.orderId) ?? notFound(ctx, "audit.read", "order", input.orderId);
    enforce(ctx, { operation: "audit.read", resource: { type: "order", scope: found.scope, order: orderFacts(found.order) } });
    resources = resourcesForOrders(ctx, [found.order.id]);
  } else if (input.customerId !== undefined) {
    const found = loadCustomer(ctx.db, input.customerId) ?? notFound(ctx, "audit.read", "customer", input.customerId);
    enforce(ctx, { operation: "audit.read", resource: { type: "customer", scope: found.scope } });
    const orderIds = ctx.db.select({ id: orders.id }).from(orders).where(eq(orders.customerId, found.customer.id)).all();
    resources = [{ type: "customer", id: String(found.customer.id) }, ...resourcesForOrders(ctx, orderIds.map((o) => o.id))];
  } else {
    enforce(ctx, { operation: "audit.read", resource: { type: "collection", name: "audit" } });
  }

  const visibility = eventVisibility(ctx, ctx.actor);
  const events = listAuditEvents(ctx.db, { actorIds: visibility.actorIds, resources, limit: input.limit });
  return {
    visibility: visibility.scope,
    note: VISIBILITY_NOTES[visibility.scope],
    events: events.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      actorId: e.actorId,
      actorRole: e.actorRole,
      action: e.action,
      resource: e.resourceType ? (e.resourceId ? `${e.resourceType}:${e.resourceId}` : e.resourceType) : null,
      decision: e.decision,
      reason: e.reason,
      correlationId: e.correlationId,
      channel: e.channel,
      metadata: e.metadata ? (JSON.parse(e.metadata) as Record<string, unknown>) : null,
    })),
  };
}

function resourcesForOrders(ctx: ExecutionContext, orderIds: number[]) {
  if (orderIds.length === 0) return [];
  const approvals = ctx.db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(inArray(approvalRequests.resourceId, orderIds.map(String)))
    .all();
  return [
    ...orderIds.map((id) => ({ type: "order", id: String(id) })),
    ...approvals.map((a) => ({ type: "approval", id: a.id })),
  ];
}

export interface TraceFilterInput {
  correlationId?: string;
  actorId?: string;
  outcome?: TraceOutcome;
  limit?: number;
}

/** Diagnostic traces for the execution viewer, scoped like audit history. Reads are not audited. */
export function listTraces(ctx: ExecutionContext, filter: TraceFilterInput = {}) {
  requireActor(ctx, "trace.read");
  const visibility = eventVisibility(ctx, ctx.actor);
  let actorIds = visibility.actorIds;
  if (filter.actorId) {
    actorIds = actorIds ? actorIds.filter((id) => id === filter.actorId) : [filter.actorId];
    if (actorIds.length === 0) return { visibility: visibility.scope, events: [] };
  }
  return {
    visibility: visibility.scope,
    events: listTraceEvents(ctx.db, {
      actorIds,
      correlationId: filter.correlationId || undefined,
      outcome: filter.outcome,
      limit: filter.limit,
    }),
  };
}

/** Audit events for the execution viewer (not exposed to the agent). */
export function listAuditForViewer(ctx: ExecutionContext, filter: { correlationId?: string; actorId?: string; decision?: string } = {}) {
  requireActor(ctx, "audit.read");
  const visibility = eventVisibility(ctx, ctx.actor);
  let actorIds = visibility.actorIds;
  if (filter.actorId) {
    actorIds = actorIds ? actorIds.filter((id) => id === filter.actorId) : [filter.actorId];
    if (actorIds.length === 0) return [];
  }
  const decision = ["allow", "deny", "requires_approval", "error"].includes(filter.decision ?? "")
    ? (filter.decision as "allow" | "deny" | "requires_approval" | "error")
    : undefined;
  return listAuditEvents(ctx.db, { actorIds, correlationId: filter.correlationId || undefined, decision, limit: 300 });
}
