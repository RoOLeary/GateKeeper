import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { approvalRequests, type ApprovalRequest } from "@gatekeeper/database";
import { newId, recordAudit } from "@gatekeeper/observability";
import { enforce, notFound, parseInput, requireActor } from "../authorization/enforce";
import type { ExecutionContext } from "../context";
import { ServiceError } from "../errors";
import { fromCents, RequestRefundInput, toCents } from "../schemas";
import { loadOrder, orderFacts, refundBalance } from "./resources";

export interface RefundRequestResult {
  status: "pending_approval";
  approvalId: string;
  message: string;
  orderId: number;
  amount: number;
  currency: string;
  /** True when this call replayed an earlier request with the same idempotency key. */
  duplicate: boolean;
}

function toResult(approval: ApprovalRequest, duplicate: boolean): RefundRequestResult {
  return {
    status: "pending_approval",
    approvalId: approval.id,
    message: "Manager approval required.",
    orderId: Number(approval.resourceId),
    amount: fromCents(approval.amountCents),
    currency: JSON.parse(approval.requestedArgs).currency,
    duplicate,
  };
}

/**
 * Requests a refund. Refunds are never executed here: a successful request always
 * produces a persisted approval that a *different* authorized user must decide on.
 */
export function requestRefund(ctx: ExecutionContext, raw: unknown): RefundRequestResult {
  requireActor(ctx, "refund.request");
  const actor = ctx.actor;
  const input = parseInput(ctx, "refund.request", RequestRefundInput, raw);
  const amountCents = toCents(input.amount);
  const idempotencyKey =
    input.idempotencyKey ??
    createHash("sha256").update(`${actor.id}:${ctx.correlationId}:${input.orderId}:${amountCents}`).digest("hex").slice(0, 32);

  const findExisting = () =>
    ctx.db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.requesterId, actor.id), eq(approvalRequests.idempotencyKey, idempotencyKey)))
      .get();

  const replay = (existing: ApprovalRequest) => {
    if (existing.resourceId !== String(input.orderId) || existing.amountCents !== amountCents) {
      throw new ServiceError("conflict", "This idempotency key was already used for a different refund request.");
    }
    recordAudit(ctx.db, {
      actor,
      action: "refund.request",
      resourceType: "order",
      resourceId: input.orderId,
      decision: "requires_approval",
      reason: "Idempotent replay — returned the existing approval request",
      correlationId: ctx.correlationId,
      channel: ctx.channel,
      metadata: { approvalId: existing.id, replay: true },
    });
    ctx.tracer?.event("approval.replayed", { name: existing.id, outcome: "pending" });
    return toResult(existing, true);
  };

  const existing = findExisting();
  if (existing) return replay(existing);

  const found = loadOrder(ctx.db, input.orderId) ?? notFound(ctx, "refund.request", "order", input.orderId);
  const balance = refundBalance(ctx.db, found.order.id);
  const approvalId = newId("apr");

  enforce(ctx, {
    operation: "refund.request",
    resource: { type: "order", scope: found.scope, order: orderFacts(found.order) },
    context: {
      refund: {
        amountCents,
        currency: input.currency,
        refundableCents: found.order.amountCents - balance.refundedCents - balance.pendingCents,
      },
    },
    audit: { metadata: { approvalId, amount: input.amount, currency: input.currency } },
  });

  const now = new Date().toISOString();
  try {
    ctx.db.transaction(
      (tx) => {
        // Re-check inside a write lock so concurrent requests cannot over-commit the order.
        const current = refundBalance(tx, found.order.id);
        if (amountCents > found.order.amountCents - current.refundedCents - current.pendingCents) {
          throw new ServiceError("conflict", "The refundable balance changed while the request was being created. Please retry.");
        }
        tx.insert(approvalRequests)
          .values({
            id: approvalId,
            operation: "refund.create",
            resourceType: "order",
            resourceId: String(found.order.id),
            requestedArgs: JSON.stringify({
              orderId: input.orderId,
              amount: input.amount,
              currency: input.currency,
              reason: input.reason,
            }),
            amountCents,
            requesterId: actor.id,
            status: "pending",
            idempotencyKey,
            resourceVersionAtRequest: found.order.version,
            correlationId: ctx.correlationId,
            createdAt: now,
          })
          .run();
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = findExisting();
      if (raced) return replay(raced);
    }
    throw error;
  }

  ctx.tracer?.event("approval.persisted", {
    name: approvalId,
    outcome: "pending",
    attributes: { orderId: input.orderId, amount: input.amount, currency: input.currency },
  });
  return toResult(ctx.db.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId)).get()!, false);
}

export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}
