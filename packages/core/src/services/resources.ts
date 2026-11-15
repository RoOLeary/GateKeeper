import { and, eq, sql } from "drizzle-orm";
import {
  approvalRequests,
  customers,
  orders,
  refunds,
  users,
  type Customer,
  type Database,
  type DbExecutor,
  type Order,
} from "@gatekeeper/database";
import type { CustomerScope, OrderFacts } from "../authorization/policy";
import { fromCents } from "../schemas";

/** Loads a customer together with the ownership facts the policy needs. */
export function loadCustomer(db: Database, customerId: number): { customer: Customer; scope: CustomerScope; repName: string } | null {
  const row = db
    .select({ customer: customers, repTeamId: users.teamId, repName: users.name })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.assignedRepId))
    .where(eq(customers.id, customerId))
    .get();
  if (!row) return null;
  return {
    customer: row.customer,
    repName: row.repName,
    scope: {
      customerId: row.customer.id,
      assignedRepId: row.customer.assignedRepId,
      repTeamId: row.repTeamId,
      accountStatus: row.customer.accountStatus,
    },
  };
}

export function loadOrder(db: Database, orderId: number) {
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return null;
  const owner = loadCustomer(db, order.customerId);
  if (!owner) return null;
  return { order, ...owner };
}

export function orderFacts(order: Order): OrderFacts {
  return { id: order.id, status: order.status, currency: order.currency, amountCents: order.amountCents };
}

export interface RefundBalance {
  refundedCents: number;
  pendingCents: number;
}

export function refundBalance(db: DbExecutor, orderId: number): RefundBalance {
  const refunded = db
    .select({ total: sql<number>`coalesce(sum(${refunds.amountCents}), 0)` })
    .from(refunds)
    .where(eq(refunds.orderId, orderId))
    .get();
  const pending = db
    .select({ total: sql<number>`coalesce(sum(${approvalRequests.amountCents}), 0)` })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.resourceId, String(orderId)), eq(approvalRequests.status, "pending")))
    .get();
  return { refundedCents: refunded?.total ?? 0, pendingCents: pending?.total ?? 0 };
}

export interface OrderView {
  id: number;
  customerId: number;
  amount: number;
  currency: string;
  status: Order["status"];
  createdAt: string;
  refundedAmount: number;
  pendingRefundAmount: number;
  refundableAmount: number;
}

export function toOrderView(order: Order, balance: RefundBalance): OrderView {
  const refundable = Math.max(0, order.amountCents - balance.refundedCents - balance.pendingCents);
  return {
    id: order.id,
    customerId: order.customerId,
    amount: fromCents(order.amountCents),
    currency: order.currency,
    status: order.status,
    createdAt: order.createdAt,
    refundedAmount: fromCents(balance.refundedCents),
    pendingRefundAmount: fromCents(balance.pendingCents),
    refundableAmount: ["cancelled", "refunded"].includes(order.status) ? 0 : fromCents(refundable),
  };
}

export interface CustomerView {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  accountStatus: Customer["accountStatus"];
  assignedRep: { id: string; name: string };
}

export function toCustomerView(customer: Customer, repName: string): CustomerView {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    accountStatus: customer.accountStatus,
    assignedRep: { id: customer.assignedRepId, name: repName },
  };
}
