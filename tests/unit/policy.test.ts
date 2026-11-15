import { describe, expect, it } from "vitest";
import { authorize, type Actor, type CustomerScope, type Resource } from "@gatekeeper/core";

const alice: Actor = { id: "u_alice", name: "Alice", role: "support_agent", teamId: "north", refundApprovalLimitCents: null };
const maya: Actor = { id: "u_maya", name: "Maya", role: "manager", teamId: "north", refundApprovalLimitCents: 50_000 };
const sam: Actor = { id: "u_sam", name: "Sam", role: "manager", teamId: "south", refundApprovalLimitCents: 20_000 };
const ada: Actor = { id: "u_ada", name: "Ada", role: "admin", teamId: null, refundApprovalLimitCents: 1_000_000 };

const aliceCustomer: CustomerScope = { customerId: 1024, assignedRepId: "u_alice", repTeamId: "north", accountStatus: "active" };
const bobCustomer: CustomerScope = { customerId: 1026, assignedRepId: "u_bob", repTeamId: "south", accountStatus: "active" };
const order = { id: 5021, status: "delivered" as const, currency: "EUR", amountCents: 24_000 };

const approval = (amountCents: number, requesterId = "u_alice"): Resource => ({
  type: "approval",
  scope: aliceCustomer,
  order,
  approval: { id: "apr_test", requesterId, amountCents },
});
const refundCtx = (amountCents: number) => ({ refund: { amountCents, currency: "EUR", refundableCents: 24_000 } });

describe("authorize()", () => {
  it("fails closed without an authenticated actor", () => {
    const d = authorize({ actor: null, operation: "customer.read", resource: { type: "customer", scope: aliceCustomer } });
    expect(d.effect).toBe("deny");
    expect(d.code).toBe("unauthenticated");
  });

  it("lets support agents read assigned customers only", () => {
    expect(authorize({ actor: alice, operation: "customer.read", resource: { type: "customer", scope: aliceCustomer } }).effect).toBe("allow");
    const denied = authorize({ actor: alice, operation: "customer.read", resource: { type: "customer", scope: bobCustomer } });
    expect(denied).toMatchObject({ effect: "deny", code: "not_assigned" });
  });

  it("scopes managers to their team and lets admins see everything", () => {
    expect(authorize({ actor: maya, operation: "customer.read", resource: { type: "customer", scope: bobCustomer } }).code).toBe("outside_team");
    expect(authorize({ actor: sam, operation: "customer.read", resource: { type: "customer", scope: bobCustomer } }).effect).toBe("allow");
    expect(authorize({ actor: ada, operation: "customer.read", resource: { type: "customer", scope: bobCustomer } }).effect).toBe("allow");
  });

  it("enforces the writable-field allowlist per role", () => {
    const resource: Resource = { type: "customer", scope: aliceCustomer };
    expect(authorize({ actor: alice, operation: "customer.update", resource, context: { changedFields: ["email"] } }).effect).toBe("allow");
    expect(authorize({ actor: alice, operation: "customer.update", resource, context: { changedFields: ["accountStatus"] } }).code).toBe("field_not_writable");
    expect(authorize({ actor: ada, operation: "customer.update", resource, context: { changedFields: ["accountStatus"] } }).effect).toBe("allow");
    expect(authorize({ actor: alice, operation: "customer.update", resource, context: {} }).code).toBe("missing_context");
  });

  it("always requires approval for refund requests, even from admins", () => {
    for (const actor of [alice, ada]) {
      const scope = actor === alice ? aliceCustomer : bobCustomer;
      const d = authorize({ actor, operation: "refund.request", resource: { type: "order", scope, order }, context: refundCtx(12_000) });
      expect(d.effect).toBe("requires_approval");
    }
  });

  it("rejects refunds on non-refundable orders and above the refundable balance", () => {
    const cancelled = { ...order, status: "cancelled" as const };
    expect(
      authorize({ actor: alice, operation: "refund.request", resource: { type: "order", scope: aliceCustomer, order: cancelled }, context: refundCtx(100) }).code,
    ).toBe("order_not_refundable");
    expect(
      authorize({ actor: alice, operation: "refund.request", resource: { type: "order", scope: aliceCustomer, order }, context: refundCtx(30_000) }).code,
    ).toBe("amount_exceeds_refundable");
  });

  it("does not let support agents approve refunds", () => {
    const d = authorize({ actor: alice, operation: "approval.approve", resource: approval(12_000, "u_carl"), context: refundCtx(12_000) });
    expect(d).toMatchObject({ effect: "deny", code: "role_not_permitted" });
  });

  it("blocks self-approval", () => {
    const d = authorize({ actor: maya, operation: "approval.approve", resource: approval(12_000, "u_maya"), context: refundCtx(12_000) });
    expect(d.code).toBe("self_approval");
  });

  it("enforces manager approval limits", () => {
    const within = authorize({ actor: maya, operation: "approval.approve", resource: approval(12_000), context: refundCtx(12_000) });
    expect(within.effect).toBe("allow");
    const big: Resource = { ...approval(60_000), order: { ...order, amountCents: 100_000 } } as Resource;
    const over = authorize({
      actor: maya,
      operation: "approval.approve",
      resource: big,
      context: { refund: { amountCents: 60_000, currency: "EUR", refundableCents: 100_000 } },
    });
    expect(over).toMatchObject({ effect: "deny", code: "approval_limit_exceeded" });
  });

  it("records every evaluated check for explainability", () => {
    const d = authorize({ actor: maya, operation: "approval.approve", resource: approval(12_000), context: refundCtx(12_000) });
    expect(d.checks.map((c) => c.name)).toEqual(["identity", "role", "scope", "restrictions", "approval", "financial_limit"]);
    expect(d.checks.every((c) => c.passed)).toBe(true);
  });
});
