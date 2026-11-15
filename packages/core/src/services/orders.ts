import { desc, eq } from "drizzle-orm";
import { orders } from "@gatekeeper/database";
import { enforce, notFound, parseInput, requireActor } from "../authorization/enforce";
import type { ExecutionContext } from "../context";
import { GetOrderStatusInput, ListCustomerOrdersInput } from "../schemas";
import { loadCustomer, loadOrder, orderFacts, refundBalance, toOrderView, type OrderView } from "./resources";

export interface CustomerOrders {
  customerId: number;
  customerName: string;
  orders: OrderView[];
}

export function listCustomerOrders(ctx: ExecutionContext, raw: unknown): CustomerOrders {
  requireActor(ctx, "order.read");
  const input = parseInput(ctx, "order.read", ListCustomerOrdersInput, raw);
  const found = loadCustomer(ctx.db, input.customerId) ?? notFound(ctx, "order.read", "customer", input.customerId);
  enforce(ctx, { operation: "order.read", resource: { type: "customer", scope: found.scope } });

  const rows = ctx.db
    .select()
    .from(orders)
    .where(eq(orders.customerId, input.customerId))
    .orderBy(desc(orders.createdAt))
    .all();
  return {
    customerId: found.customer.id,
    customerName: found.customer.name,
    orders: rows.map((o) => toOrderView(o, refundBalance(ctx.db, o.id))),
  };
}

export function getOrderStatus(ctx: ExecutionContext, raw: unknown): OrderView {
  requireActor(ctx, "order.read");
  const input = parseInput(ctx, "order.read", GetOrderStatusInput, raw);
  const found = loadOrder(ctx.db, input.orderId) ?? notFound(ctx, "order.read", "order", input.orderId);
  enforce(ctx, { operation: "order.read", resource: { type: "order", scope: found.scope, order: orderFacts(found.order) } });
  return toOrderView(found.order, refundBalance(ctx.db, found.order.id));
}
