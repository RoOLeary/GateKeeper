import { asc, desc, eq, inArray } from "drizzle-orm";
import { customers, orders, refunds, users } from "@gatekeeper/database";
import { enforce, notFound, parseInput, requireActor } from "../authorization/enforce";
import type { Actor, ExecutionContext } from "../context";
import { fromCents, GetCustomerInput, UpdateCustomerInput } from "../schemas";
import { loadCustomer, refundBalance, toCustomerView, toOrderView, type CustomerView, type OrderView } from "./resources";

export function getCustomer(ctx: ExecutionContext, raw: unknown): CustomerView {
  requireActor(ctx, "customer.read");
  const input = parseInput(ctx, "customer.read", GetCustomerInput, raw);
  const found = loadCustomer(ctx.db, input.customerId) ?? notFound(ctx, "customer.read", "customer", input.customerId);
  enforce(ctx, { operation: "customer.read", resource: { type: "customer", scope: found.scope } });
  return toCustomerView(found.customer, found.repName);
}

export interface UpdateCustomerResult {
  customer: CustomerView;
  changedFields: string[];
}

export function updateCustomer(ctx: ExecutionContext, raw: unknown): UpdateCustomerResult {
  requireActor(ctx, "customer.update");
  const input = parseInput(ctx, "customer.update", UpdateCustomerInput, raw);
  const found = loadCustomer(ctx.db, input.customerId) ?? notFound(ctx, "customer.update", "customer", input.customerId);

  const changes = Object.fromEntries(Object.entries(input.changes).filter(([, v]) => v !== undefined));
  const changedFields = Object.keys(changes);

  enforce(ctx, {
    operation: "customer.update",
    resource: { type: "customer", scope: found.scope },
    context: { changedFields },
    // Field names only — never the new values, which may be personal data.
    audit: { metadata: { fields: changedFields } },
  });

  ctx.db
    .update(customers)
    .set({ ...changes, updatedAt: new Date().toISOString() })
    .where(eq(customers.id, input.customerId))
    .run();

  const updated = loadCustomer(ctx.db, input.customerId)!;
  return { customer: toCustomerView(updated.customer, updated.repName), changedFields };
}

/** IDs of customers an actor may see. `null` means unrestricted (administrators). */
export function visibleCustomerIds(ctx: ExecutionContext, actor: Actor): number[] | null {
  if (actor.role === "admin") return null;
  if (actor.role === "support_agent") {
    return ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.assignedRepId, actor.id))
      .all()
      .map((r) => r.id);
  }
  if (!actor.teamId) return [];
  return ctx.db
    .select({ id: customers.id })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.assignedRepId))
    .where(eq(users.teamId, actor.teamId))
    .all()
    .map((r) => r.id);
}

export interface RefundView {
  id: string;
  orderId: number;
  amount: number;
  currency: string;
  status: string;
  reason: string;
  requestedBy: string;
  approvedBy: string;
  approvalRequestId: string | null;
  createdAt: string;
}

export interface OperationsOverview {
  customers: Array<CustomerView & { orders: OrderView[] }>;
  refunds: RefundView[];
}

/** Scoped snapshot powering the Customer Operations view. */
export function getOperationsOverview(ctx: ExecutionContext): OperationsOverview {
  requireActor(ctx, "customer.list");
  enforce(ctx, { operation: "customer.list", resource: { type: "collection", name: "customer" } });

  const ids = visibleCustomerIds(ctx, ctx.actor);
  if (ids !== null && ids.length === 0) return { customers: [], refunds: [] };

  const rows = ctx.db
    .select({ customer: customers, repName: users.name })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.assignedRepId))
    .where(ids === null ? undefined : inArray(customers.id, ids))
    .orderBy(asc(customers.id))
    .all();
  const customerIds = rows.map((r) => r.customer.id);
  const orderRows = ctx.db
    .select()
    .from(orders)
    .where(inArray(orders.customerId, customerIds))
    .orderBy(desc(orders.createdAt))
    .all();
  const refundRows = ctx.db
    .select()
    .from(refunds)
    .where(inArray(refunds.orderId, orderRows.map((o) => o.id)))
    .orderBy(desc(refunds.createdAt))
    .all();

  return {
    customers: rows.map(({ customer, repName }) => ({
      ...toCustomerView(customer, repName),
      orders: orderRows
        .filter((o) => o.customerId === customer.id)
        .map((o) => toOrderView(o, refundBalance(ctx.db, o.id))),
    })),
    refunds: refundRows.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      amount: fromCents(r.amountCents),
      currency: r.currency,
      status: r.status,
      reason: r.reason,
      requestedBy: r.requestedBy,
      approvedBy: r.approvedBy,
      approvalRequestId: r.approvalRequestId,
      createdAt: r.createdAt,
    })),
  };
}
