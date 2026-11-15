import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  approvalRequests,
  orders,
  refunds,
  users,
  type ApprovalRequest,
  type ApprovalStatus,
  type Database,
} from "@gatekeeper/database";
import { newId, recordAudit } from "@gatekeeper/observability";
import { enforce, notFound, parseInput, requireActor } from "../authorization/enforce";
import {
  authorize,
  RESOURCE_STATE_CODES,
  type AuthorizationDecision,
  type PolicyCheck,
  type Resource,
} from "../authorization/policy";
import type { Actor, ExecutionContext } from "../context";
import { isServiceError, ServiceError } from "../errors";
import { DecideApprovalInput, fromCents, GetApprovalStatusInput, StoredRefundArgs } from "../schemas";
import { loadOrder, orderFacts, refundBalance } from "../services/resources";

export interface ApprovalView {
  id: string;
  operation: string;
  status: ApprovalStatus;
  orderId: number;
  customerId: number;
  customerName: string;
  amount: number;
  currency: string;
  reason: string;
  requester: { id: string; name: string };
  approver: { id: string; name: string } | null;
  decisionReason: string | null;
  refundId: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  correlationId: string | null;
}

export interface ApprovalPreview {
  canApprove: boolean;
  canReject: boolean;
  reason: string;
  checks: PolicyCheck[];
}

const requesterUser = alias(users, "requester");
const approverUser = alias(users, "approver");

function loadApproval(db: Database, approvalId: string) {
  const row = db
    .select({ approval: approvalRequests, requesterName: requesterUser.name, approverName: approverUser.name })
    .from(approvalRequests)
    .innerJoin(requesterUser, eq(requesterUser.id, approvalRequests.requesterId))
    .leftJoin(approverUser, eq(approverUser.id, approvalRequests.approverId))
    .where(eq(approvalRequests.id, approvalId))
    .get();
  if (!row) return null;
  const owner = loadOrder(db, Number(row.approval.resourceId));
  if (!owner) return null;
  return { ...row, ...owner };
}

type LoadedApproval = NonNullable<ReturnType<typeof loadApproval>>;

function toView(found: LoadedApproval): ApprovalView {
  const { approval } = found;
  const args = JSON.parse(approval.requestedArgs) as { currency?: string; reason?: string };
  return {
    id: approval.id,
    operation: approval.operation,
    status: approval.status,
    orderId: found.order.id,
    customerId: found.customer.id,
    customerName: found.customer.name,
    amount: fromCents(approval.amountCents),
    currency: args.currency ?? found.order.currency,
    reason: args.reason ?? "",
    requester: { id: approval.requesterId, name: found.requesterName },
    approver: approval.approverId ? { id: approval.approverId, name: found.approverName ?? approval.approverId } : null,
    decisionReason: approval.decisionReason,
    refundId: approval.resultRefundId,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt,
    executedAt: approval.executedAt,
    correlationId: approval.correlationId,
  };
}

function approvalResource(found: LoadedApproval): Resource {
  return {
    type: "approval",
    scope: found.scope,
    order: orderFacts(found.order),
    approval: { id: found.approval.id, requesterId: found.approval.requesterId, amountCents: found.approval.amountCents },
  };
}

/** Refund context for approval: only *completed* refunds count against the balance. */
function approvalRefundContext(db: Database, found: LoadedApproval) {
  const balance = refundBalance(db, found.order.id);
  const args = JSON.parse(found.approval.requestedArgs) as { currency?: string };
  return {
    amountCents: found.approval.amountCents,
    currency: args.currency ?? "",
    refundableCents: found.order.amountCents - balance.refundedCents,
  };
}

export function getApprovalStatus(ctx: ExecutionContext, raw: unknown): ApprovalView {
  requireActor(ctx, "approval.read");
  const input = parseInput(ctx, "approval.read", GetApprovalStatusInput, raw);
  const found = loadApproval(ctx.db, input.approvalId) ?? notFound(ctx, "approval.read", "approval", input.approvalId);
  enforce(ctx, { operation: "approval.read", resource: approvalResource(found) });
  return toView(found);
}

/** Pure policy preview of what the actor could do with a pending approval. Not audited. */
function preview(db: Database, actor: Actor, found: LoadedApproval): ApprovalPreview {
  const resource = approvalResource(found);
  const approve = authorize({
    actor,
    operation: "approval.approve",
    resource,
    context: { refund: approvalRefundContext(db, found) },
  });
  const reject = authorize({ actor, operation: "approval.reject", resource });
  return {
    canApprove: approve.effect === "allow",
    canReject: reject.effect === "allow",
    reason: approve.effect === "allow" ? "You can approve this request." : approve.reason,
    checks: approve.checks,
  };
}

export function listApprovals(
  ctx: ExecutionContext,
  filter: { status?: ApprovalStatus } = {},
): Array<ApprovalView & { preview: ApprovalPreview | null }> {
  requireActor(ctx, "approval.read");
  enforce(ctx, { operation: "approval.read", resource: { type: "collection", name: "approval" } });
  const actor = ctx.actor;

  const rows = ctx.db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(filter.status ? eq(approvalRequests.status, filter.status) : undefined)
    .orderBy(desc(approvalRequests.createdAt))
    .all();

  return rows.flatMap(({ id }) => {
    const found = loadApproval(ctx.db, id);
    if (!found) return [];
    const visible = authorize({ actor, operation: "approval.read", resource: approvalResource(found) });
    if (visible.effect !== "allow") return [];
    return [{ ...toView(found), preview: found.approval.status === "pending" ? preview(ctx.db, actor, found) : null }];
  });
}

/** Number of pending approvals the actor could approve right now. Policy-filtered; returns no record data, so not audited. */
export function countActionableApprovals(db: Database, actor: Actor | null): number {
  if (!actor) return 0;
  return db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(eq(approvalRequests.status, "pending"))
    .all()
    .filter(({ id }) => {
      const found = loadApproval(db, id);
      return found ? preview(db, actor, found).canApprove : false;
    }).length;
}

export interface ApprovalDecisionResult {
  status: "approved" | "rejected" | "invalidated";
  approvalId: string;
  message: string;
  refundId?: string;
}

/**
 * Approves or rejects a pending request. Approval re-validates the stored arguments,
 * re-checks the approver's authority and the order's *current* state, then executes
 * the refund exactly once inside a write-locked transaction.
 */
export function decideApproval(ctx: ExecutionContext, raw: unknown): ApprovalDecisionResult {
  const decisionOp = (raw as { decision?: string })?.decision === "reject" ? "approval.reject" : "approval.approve";
  requireActor(ctx, decisionOp);
  const actor = ctx.actor;
  const input = parseInput(ctx, decisionOp, DecideApprovalInput, raw);
  const operation = input.decision === "approve" ? "approval.approve" : "approval.reject";
  const found = loadApproval(ctx.db, input.approvalId) ?? notFound(ctx, operation, "approval", input.approvalId);
  const auditMeta = { orderId: found.order.id, amount: fromCents(found.approval.amountCents) };

  if (found.approval.status !== "pending") {
    recordAudit(ctx.db, {
      actor,
      action: operation,
      resourceType: "approval",
      resourceId: found.approval.id,
      decision: "deny",
      reason: `Approval is already ${found.approval.status}`,
      correlationId: ctx.correlationId,
      channel: ctx.channel,
      metadata: { code: "not_pending", ...auditMeta },
    });
    ctx.tracer?.event("approval.replay_blocked", { name: found.approval.id, outcome: "denied" });
    throw new ServiceError("conflict", `Approval ${found.approval.id} is already ${found.approval.status} and cannot be decided again.`);
  }

  if (input.decision === "reject") {
    enforce(ctx, { operation, resource: approvalResource(found), audit: { metadata: auditMeta } });
    const now = new Date().toISOString();
    const changed = ctx.db
      .update(approvalRequests)
      .set({ status: "rejected", approverId: actor.id, decisionReason: input.note ?? "Rejected", decidedAt: now })
      .where(and(eq(approvalRequests.id, found.approval.id), eq(approvalRequests.status, "pending")))
      .run().changes;
    if (changed !== 1) throw new ServiceError("conflict", "The approval was decided concurrently.");
    ctx.tracer?.event("approval.rejected", { name: found.approval.id, outcome: "ok" });
    return { status: "rejected", approvalId: found.approval.id, message: "Refund request rejected. No refund was issued." };
  }

  // Re-validate what was stored: the original request is untrusted input too.
  const parsedArgs = StoredRefundArgs.safeParse(JSON.parse(found.approval.requestedArgs));
  if (!parsedArgs.success || parsedArgs.data.orderId !== found.order.id) {
    return invalidate(ctx, found, "Stored request arguments failed re-validation.");
  }

  const orderChangedSinceRequest = found.order.version !== found.approval.resourceVersionAtRequest;
  let decision: AuthorizationDecision;
  try {
    decision = enforce(ctx, {
      operation,
      resource: approvalResource(found),
      context: { refund: approvalRefundContext(ctx.db, found) },
      audit: { metadata: { ...auditMeta, orderChangedSinceRequest } },
    });
  } catch (error) {
    if (isServiceError(error) && error.decision && RESOURCE_STATE_CODES.has(error.decision.code)) {
      return invalidate(ctx, found, error.decision.reason);
    }
    throw error;
  }

  const refundId = newId("rf");
  const now = new Date().toISOString();
  ctx.db.transaction(
    (tx) => {
      // Fence 1: the order must not have changed between the policy check and execution.
      const order = tx.select().from(orders).where(eq(orders.id, found.order.id)).get();
      if (!order || order.version !== found.order.version) {
        throw new ServiceError("conflict", "The order changed while the approval was being processed. Please retry.");
      }
      // Fence 2: only a still-pending approval can transition; a replay updates zero rows.
      const changed = tx
        .update(approvalRequests)
        .set({
          status: "approved",
          approverId: actor.id,
          decisionReason: input.note ?? "Approved",
          decidedAt: now,
          executedAt: now,
          resultRefundId: refundId,
        })
        .where(and(eq(approvalRequests.id, found.approval.id), eq(approvalRequests.status, "pending")))
        .run().changes;
      if (changed !== 1) throw new ServiceError("conflict", "The approval was decided concurrently.");

      // Fence 3: UNIQUE(approval_request_id) and UNIQUE(idempotency_key) make a second refund impossible.
      tx.insert(refunds)
        .values({
          id: refundId,
          orderId: order.id,
          amountCents: found.approval.amountCents,
          currency: order.currency,
          status: "completed",
          reason: parsedArgs.data.reason,
          requestedBy: found.approval.requesterId,
          approvedBy: actor.id,
          approvalRequestId: found.approval.id,
          idempotencyKey: `approval:${found.approval.id}`,
          createdAt: now,
        })
        .run();

      const refunded = refundBalance(tx, order.id).refundedCents;
      tx.update(orders)
        .set({
          status: refunded >= order.amountCents ? "refunded" : "partially_refunded",
          version: order.version + 1,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id))
        .run();

      recordAudit(tx, {
        actor,
        action: "refund.execute",
        resourceType: "order",
        resourceId: order.id,
        decision: "allow",
        reason: `Refund ${refundId} executed after approval ${found.approval.id}`,
        correlationId: ctx.correlationId,
        channel: ctx.channel,
        metadata: { approvalId: found.approval.id, refundId, amount: auditMeta.amount, requesterId: found.approval.requesterId },
      });
    },
    { behavior: "immediate" },
  );

  ctx.tracer?.event("approval.executed", {
    name: found.approval.id,
    outcome: "ok",
    attributes: { refundId, orderId: found.order.id, amount: auditMeta.amount, policy: decision.code },
  });
  return {
    status: "approved",
    approvalId: found.approval.id,
    refundId,
    message: `Refund of ${fromCents(found.approval.amountCents).toFixed(2)} ${found.order.currency} executed for order ${found.order.id}.`,
  };
}

function invalidate(ctx: ExecutionContext, found: LoadedApproval, reason: string): ApprovalDecisionResult {
  const now = new Date().toISOString();
  ctx.db
    .update(approvalRequests)
    .set({ status: "invalidated", approverId: ctx.actor?.id ?? null, decisionReason: reason, decidedAt: now })
    .where(and(eq(approvalRequests.id, found.approval.id), eq(approvalRequests.status, "pending")))
    .run();
  recordAudit(ctx.db, {
    actor: ctx.actor,
    action: "approval.invalidate",
    resourceType: "approval",
    resourceId: found.approval.id,
    decision: "deny",
    reason,
    correlationId: ctx.correlationId,
    channel: ctx.channel,
    metadata: { orderId: found.order.id, orderStatus: found.order.status },
  });
  ctx.tracer?.event("approval.invalidated", { name: found.approval.id, outcome: "denied", attributes: { reason } });
  return {
    status: "invalidated",
    approvalId: found.approval.id,
    message: `The request is no longer safe to execute and was invalidated: ${reason}`,
  };
}

export type { ApprovalRequest };
