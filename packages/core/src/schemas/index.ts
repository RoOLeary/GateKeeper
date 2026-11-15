import { z } from "zod";
import { ACCOUNT_STATUSES } from "@gatekeeper/database";

/**
 * Tool input schemas, shared by the MCP server (advertised + enforced), the agent
 * (pre-flight validation) and the services (defence in depth).
 *
 * Note what is *absent*: no schema accepts a user ID, role or permission. Identity
 * always comes from the trusted execution context.
 */

const customerId = z.number().int().positive().describe("Numeric customer ID, e.g. 1024");
const orderId = z.number().int().positive().describe("Numeric order ID, e.g. 5021");

const money = z
  .number()
  .positive()
  .max(1_000_000)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Amount can have at most two decimal places");

export const GetCustomerInput = z.strictObject({ customerId });

export const ListCustomerOrdersInput = z.strictObject({ customerId });

export const GetOrderStatusInput = z.strictObject({ orderId });

export const CustomerChanges = z
  .strictObject({
    email: z.email().max(254).optional(),
    phone: z
      .string()
      .regex(/^\+?[0-9 ()-]{6,24}$/, "Phone numbers may contain digits, spaces, parentheses and dashes")
      .optional(),
    accountStatus: z.enum(ACCOUNT_STATUSES).optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), "At least one field must be changed");

export const UpdateCustomerInput = z.strictObject({
  customerId,
  changes: CustomerChanges.describe("Fields to change. Only email and phone are editable by most roles."),
});

export const RequestRefundInput = z.strictObject({
  orderId,
  amount: money.describe("Refund amount in major currency units, e.g. 120 for €120.00"),
  currency: z
    .string()
    .length(3)
    .transform((c) => c.toUpperCase())
    .describe("ISO 4217 currency code; must match the order currency, e.g. EUR"),
  reason: z.string().trim().min(3).max(500).describe("Why the refund is being requested"),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .optional()
    .describe("Client-generated key that makes retries safe. Repeating a key returns the original request."),
});

export const GetApprovalStatusInput = z.strictObject({
  approvalId: z
    .string()
    .regex(/^apr_[A-Za-z0-9_]+$/, "Approval IDs look like apr_…")
    .describe("Approval request ID returned by request_refund"),
});

export const GetAuditHistoryInput = z.strictObject({
  orderId: orderId.optional(),
  customerId: customerId.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const DecideApprovalInput = z.strictObject({
  approvalId: GetApprovalStatusInput.shape.approvalId,
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional(),
});

export type GetCustomerInput = z.infer<typeof GetCustomerInput>;
export type ListCustomerOrdersInput = z.infer<typeof ListCustomerOrdersInput>;
export type GetOrderStatusInput = z.infer<typeof GetOrderStatusInput>;
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerInput>;
export type RequestRefundInput = z.infer<typeof RequestRefundInput>;
export type GetApprovalStatusInput = z.infer<typeof GetApprovalStatusInput>;
export type GetAuditHistoryInput = z.infer<typeof GetAuditHistoryInput>;
export type DecideApprovalInput = z.infer<typeof DecideApprovalInput>;

/** Shape of the arguments persisted on a refund approval request. */
export const StoredRefundArgs = z.strictObject({
  orderId,
  amount: money,
  currency: z.string().length(3),
  reason: z.string().min(3).max(500),
});

export const toCents = (amount: number) => Math.round(amount * 100);
export const fromCents = (cents: number) => cents / 100;

/** Catalogue used by the MCP server and the agent's pre-flight validation. */
export const TOOL_INPUT_SCHEMAS = {
  get_customer: GetCustomerInput,
  list_customer_orders: ListCustomerOrdersInput,
  get_order_status: GetOrderStatusInput,
  update_customer: UpdateCustomerInput,
  request_refund: RequestRefundInput,
  get_approval_status: GetApprovalStatusInput,
  get_audit_history: GetAuditHistoryInput,
} as const;

export type ToolName = keyof typeof TOOL_INPUT_SCHEMAS;

/** Tools with side effects. The agent never retries these and always attaches an idempotency key where supported. */
export const MUTATING_TOOLS: ReadonlySet<ToolName> = new Set(["update_customer", "request_refund"]);
