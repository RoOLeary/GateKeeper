import { describe, expect, it } from "vitest";
import { verifyReply, type ToolCallRecord } from "@gatekeeper/agent";

const pending: ToolCallRecord = {
  callId: "c1",
  name: "request_refund",
  arguments: {},
  executed: true,
  status: "pending_approval",
  message: "Manager approval required.",
  approvalId: "apr_123",
  durationMs: 3,
};

describe("verifyReply()", () => {
  it.each([
    "Your refund has been processed.",
    "All refunds have been processed successfully.",
    "I've issued the refund of €120.",
    "The refund was successfully completed.",
    "I have successfully refunded the customer.",
  ])("flags false success claim: %s", (reply) => {
    expect(verifyReply(reply, [pending])[0]).toMatch(/apr_123 is pending manager approval/);
  });

  it.each([
    "I've submitted a refund request; it is pending manager approval (apr_123).",
    "The refund cannot be processed until a manager approves it.",
    "Gatekeeper denied the refund request.",
  ])("accepts accurate reply: %s", (reply) => {
    expect(verifyReply(reply, [pending])).toEqual([]);
  });

  it("allows success language once approval status confirms execution", () => {
    const approved: ToolCallRecord = { ...pending, name: "get_approval_status", status: "ok", message: "Approval apr_123 is approved." };
    expect(verifyReply("The refund has been processed.", [approved])).toEqual([]);
  });
});
