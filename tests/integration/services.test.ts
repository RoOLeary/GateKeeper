import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents, customers } from "@gatekeeper/database";
import { getAuditHistory, getCustomer, getOrderStatus, listCustomerOrders, requestRefund, updateCustomer } from "@gatekeeper/core";
import { createTestEnv, expectServiceError } from "../helpers";

describe("customer & order services", () => {
  it("returns assigned customers to support agents", () => {
    const { ctx } = createTestEnv();
    expect(getCustomer(ctx("u_alice"), { customerId: 1024 })).toMatchObject({ id: 1024, name: "Niamh Kelly" });
  });

  it("denies support agents access to unassigned customers and audits the denial", () => {
    const { db, ctx } = createTestEnv();
    const c = ctx("u_alice");
    const err = expectServiceError(() => getCustomer(c, { customerId: 1026 }), "forbidden");
    expect(err.message).toContain("not assigned");
    expectServiceError(() => listCustomerOrders(c, { customerId: 1026 }), "forbidden");
    expectServiceError(() => getOrderStatus(c, { orderId: 5024 }), "forbidden");

    const events = db.select().from(auditEvents).where(eq(auditEvents.correlationId, c.correlationId)).all();
    expect(events.filter((e) => e.decision === "deny")).toHaveLength(3);
  });

  it("fails closed when identity context is missing", () => {
    const { db, ctx } = createTestEnv();
    const c = ctx(null);
    expectServiceError(() => getCustomer(c, { customerId: 1024 }), "unauthenticated");
    expectServiceError(() => requestRefund(c, { orderId: 5021, amount: 10, currency: "EUR", reason: "test" }), "unauthenticated");
    const [event] = db.select().from(auditEvents).where(eq(auditEvents.correlationId, c.correlationId)).all();
    expect(event).toMatchObject({ actorId: null, decision: "deny" });
  });

  it("rejects invalid arguments, including smuggled identity fields", () => {
    const { ctx } = createTestEnv();
    const c = ctx("u_alice");
    expectServiceError(() => getCustomer(c, { customerId: "1024; DROP TABLE" }), "invalid_input");
    expectServiceError(() => getCustomer(c, { customerId: 1026, actorId: "u_ada" }), "invalid_input");
    expectServiceError(() => requestRefund(c, { orderId: 5021, amount: -5, currency: "EUR", reason: "x" }), "invalid_input");
    expectServiceError(() => requestRefund(c, { orderId: 5021, amount: 10.005, currency: "EUR", reason: "rounding" }), "invalid_input");
  });

  it("only updates allowlisted fields and never logs new values", () => {
    const { db, ctx } = createTestEnv();
    const c = ctx("u_alice");
    const result = updateCustomer(c, { customerId: 1024, changes: { email: "niamh@new.example.com" } });
    expect(result.customer.email).toBe("niamh@new.example.com");
    expectServiceError(() => updateCustomer(c, { customerId: 1024, changes: { accountStatus: "closed" } }), "forbidden");
    expectServiceError(() => updateCustomer(c, { customerId: 1024, changes: { assignedRepId: "u_alice" } }), "invalid_input");
    expect(db.select().from(customers).where(eq(customers.id, 1024)).get()?.accountStatus).toBe("active");

    const audit = db.select().from(auditEvents).where(eq(auditEvents.correlationId, c.correlationId)).all();
    expect(JSON.stringify(audit)).not.toContain("niamh@new.example.com");
  });

  it("scopes audit history by role", () => {
    const { ctx } = createTestEnv();
    getCustomer(ctx("u_alice"), { customerId: 1024 });
    getCustomer(ctx("u_maya"), { customerId: 1024 });
    getCustomer(ctx("u_sam"), { customerId: 1026 });

    const own = getAuditHistory(ctx("u_alice"), {});
    expect(own.visibility).toBe("own");
    expect(new Set(own.events.map((e) => e.actorId))).toEqual(new Set(["u_alice"]));

    const team = getAuditHistory(ctx("u_maya"), {});
    expect(team.events.some((e) => e.actorId === "u_sam")).toBe(false);

    const all = getAuditHistory(ctx("u_ada"), {});
    expect(all.events.some((e) => e.actorId === "u_sam") && all.events.some((e) => e.actorId === "u_alice")).toBe(true);

    expectServiceError(() => getAuditHistory(ctx("u_alice"), { orderId: 5024 }), "forbidden");
  });
});
