import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, orders, refunds } from "@gatekeeper/database";
import { decideApproval, getApprovalStatus, getOrderStatus, listApprovals, requestRefund } from "@gatekeeper/core";
import { createTestEnv, expectServiceError } from "../helpers";

const refundArgs = { orderId: 5021, amount: 120, currency: "EUR", reason: "Item arrived damaged" };

describe("refund approval workflow", () => {
  it("creates a persistent pending approval instead of executing a refund", () => {
    const { db, ctx } = createTestEnv();
    const result = requestRefund(ctx("u_alice"), refundArgs);
    expect(result).toMatchObject({ status: "pending_approval", message: "Manager approval required.", duplicate: false });
    expect(result.approvalId).toMatch(/^apr_/);
    expect(db.select().from(refunds).where(eq(refunds.orderId, 5021)).all()).toHaveLength(0);
    expect(getOrderStatus(ctx("u_alice"), { orderId: 5021 }).pendingRefundAmount).toBe(120);
  });

  it("is idempotent per requester and idempotency key", () => {
    const { db, ctx } = createTestEnv();
    const first = requestRefund(ctx("u_alice"), { ...refundArgs, idempotencyKey: "key-12345678" });
    const second = requestRefund(ctx("u_alice"), { ...refundArgs, idempotencyKey: "key-12345678" });
    expect(second).toMatchObject({ approvalId: first.approvalId, duplicate: true });
    expect(db.select().from(approvalRequests).where(eq(approvalRequests.resourceId, "5021")).all()).toHaveLength(1);
    expectServiceError(() => requestRefund(ctx("u_alice"), { ...refundArgs, amount: 50, idempotencyKey: "key-12345678" }), "conflict");
  });

  it("prevents over-committing an order with multiple pending requests", () => {
    const { ctx } = createTestEnv();
    requestRefund(ctx("u_alice"), { ...refundArgs, amount: 200 });
    expectServiceError(() => requestRefund(ctx("u_alice"), { ...refundArgs, amount: 50 }), "forbidden");
  });

  it("does not let support agents approve refunds", () => {
    const { ctx } = createTestEnv();
    const { approvalId } = requestRefund(ctx("u_alice"), refundArgs);
    expectServiceError(() => decideApproval(ctx("u_carl"), { approvalId, decision: "approve" }), "forbidden");
  });

  it("does not let users approve their own requests", () => {
    const { ctx } = createTestEnv();
    const { approvalId } = requestRefund(ctx("u_maya"), refundArgs);
    const err = expectServiceError(() => decideApproval(ctx("u_maya"), { approvalId, decision: "approve" }), "forbidden");
    expect(err.message).toMatch(/cannot decide on an approval request you created/);
    expect(getApprovalStatus(ctx("u_maya"), { approvalId }).status).toBe("pending");
  });

  it("does not let managers exceed their refund limit", () => {
    const { db, ctx } = createTestEnv();
    const { approvalId } = requestRefund(ctx("u_alice"), { orderId: 5023, amount: 600, currency: "EUR", reason: "Partial return" });
    const err = expectServiceError(() => decideApproval(ctx("u_maya"), { approvalId, decision: "approve" }), "forbidden");
    expect(err.message).toMatch(/exceeds .*approval limit/);
    expect(db.select().from(refunds).where(eq(refunds.orderId, 5023)).all()).toHaveLength(0);
    // An administrator with a higher limit can still approve.
    expect(decideApproval(ctx("u_ada"), { approvalId, decision: "approve" }).status).toBe("approved");
  });

  it("keeps managers out of other teams' approvals", () => {
    const { ctx } = createTestEnv();
    const { approvalId } = requestRefund(ctx("u_alice"), refundArgs);
    expectServiceError(() => decideApproval(ctx("u_sam"), { approvalId, decision: "approve" }), "forbidden");
    expect(listApprovals(ctx("u_sam")).some((a) => a.id === approvalId)).toBe(false);
  });

  it("executes an approved refund exactly once, even when replayed", () => {
    const { db, ctx } = createTestEnv();
    const { approvalId } = requestRefund(ctx("u_alice"), refundArgs);
    const approved = decideApproval(ctx("u_maya"), { approvalId, decision: "approve" });
    expect(approved).toMatchObject({ status: "approved" });

    expectServiceError(() => decideApproval(ctx("u_maya"), { approvalId, decision: "approve" }), "conflict");
    expectServiceError(() => decideApproval(ctx("u_ada"), { approvalId, decision: "approve" }), "conflict");

    const rows = db.select().from(refunds).where(eq(refunds.approvalRequestId, approvalId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountCents: 12_000, requestedBy: "u_alice", approvedBy: "u_maya" });
    const order = db.select().from(orders).where(eq(orders.id, 5021)).get();
    expect(order).toMatchObject({ status: "partially_refunded", version: 2 });
  });

  it("enforces uniqueness at the database level as a last line of defence", () => {
    const { db, ctx } = createTestEnv();
    const { approvalId } = requestRefund(ctx("u_alice"), refundArgs);
    decideApproval(ctx("u_maya"), { approvalId, decision: "approve" });
    const existing = db.select().from(refunds).where(eq(refunds.approvalRequestId, approvalId)).get()!;
    expect(() => db.insert(refunds).values({ ...existing, id: "rf_duplicate", idempotencyKey: "other" }).run()).toThrow(/UNIQUE/);
  });

  it("never executes a rejected approval", () => {
    const { db, ctx } = createTestEnv();
    const { approvalId } = requestRefund(ctx("u_alice"), refundArgs);
    expect(decideApproval(ctx("u_maya"), { approvalId, decision: "reject", note: "Not eligible" }).status).toBe("rejected");
    expectServiceError(() => decideApproval(ctx("u_maya"), { approvalId, decision: "approve" }), "conflict");
    expect(db.select().from(refunds).where(eq(refunds.orderId, 5021)).all()).toHaveLength(0);
  });

  it("invalidates a pending refund when the order state changes underneath it", () => {
    const { db, ctx } = createTestEnv();
    const { approvalId } = requestRefund(ctx("u_alice"), refundArgs);
    db.update(orders).set({ status: "cancelled", version: 2 }).where(eq(orders.id, 5021)).run();

    const result = decideApproval(ctx("u_maya"), { approvalId, decision: "approve" });
    expect(result.status).toBe("invalidated");
    expect(result.message).toMatch(/cancelled/);
    expect(getApprovalStatus(ctx("u_alice"), { approvalId }).status).toBe("invalidated");
    expect(db.select().from(refunds).where(eq(refunds.orderId, 5021)).all()).toHaveLength(0);
  });

  it("re-validates the refundable balance at approval time", () => {
    const { db, ctx } = createTestEnv();
    const a = requestRefund(ctx("u_alice"), { ...refundArgs, amount: 200 });
    // Simulate an out-of-band refund that consumed most of the balance.
    db.insert(refunds)
      .values({
        id: "rf_manual",
        orderId: 5021,
        amountCents: 10_000,
        currency: "EUR",
        status: "completed",
        reason: "Manual adjustment",
        requestedBy: "u_ada",
        approvedBy: "u_ada",
        idempotencyKey: "manual-1",
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(decideApproval(ctx("u_maya"), { approvalId: a.approvalId, decision: "approve" }).status).toBe("invalidated");
  });

  it("shows managers a policy preview in the approval queue", () => {
    const { ctx } = createTestEnv();
    const queue = listApprovals(ctx("u_maya"), { status: "pending" });
    const seeded = queue.find((a) => a.id === "apr_seed_0002");
    expect(seeded?.preview).toMatchObject({ canApprove: true, canReject: true });
    expect(listApprovals(ctx("u_carl"), { status: "pending" }).find((a) => a.id === "apr_seed_0002")?.preview?.canApprove).toBe(false);
  });
});
