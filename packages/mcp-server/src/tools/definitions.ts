import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  getApprovalStatus,
  getAuditHistory,
  getCustomer,
  getOrderStatus,
  listCustomerOrders,
  requestRefund,
  TOOL_INPUT_SCHEMAS,
  updateCustomer,
  type ExecutionContext,
  type ToolName,
} from "@gatekeeper/core";

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Executes through the transport-independent service layer. */
  execute: (ctx: ExecutionContext, args: unknown) => { data: unknown; message: string; approvalId?: string; pending?: boolean };
}

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_customer",
    title: "Get customer",
    description:
      "Look up a single customer by numeric ID. Returns name, contact details, account status and assigned support representative.",
    inputSchema: TOOL_INPUT_SCHEMAS.get_customer,
    annotations: readOnly,
    execute: (ctx, args) => {
      const customer = getCustomer(ctx, args);
      return { data: customer, message: `Customer ${customer.id} retrieved.` };
    },
  },
  {
    name: "list_customer_orders",
    title: "List customer orders",
    description: "List all orders for a customer, newest first, including refunded and refundable amounts.",
    inputSchema: TOOL_INPUT_SCHEMAS.list_customer_orders,
    annotations: readOnly,
    execute: (ctx, args) => {
      const result = listCustomerOrders(ctx, args);
      return { data: result, message: `${result.orders.length} orders found for customer ${result.customerId}.` };
    },
  },
  {
    name: "get_order_status",
    title: "Get order status",
    description: "Get the status, amount, refunded amount and remaining refundable balance of an order.",
    inputSchema: TOOL_INPUT_SCHEMAS.get_order_status,
    annotations: readOnly,
    execute: (ctx, args) => {
      const order = getOrderStatus(ctx, args);
      return { data: order, message: `Order ${order.id} is ${order.status}.` };
    },
  },
  {
    name: "update_customer",
    title: "Update customer",
    description:
      "Update contact fields on a customer record. Writable fields are restricted by the caller's role (most roles may only change email and phone).",
    inputSchema: TOOL_INPUT_SCHEMAS.update_customer,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: (ctx, args) => {
      const result = updateCustomer(ctx, args);
      return { data: result, message: `Updated ${result.changedFields.join(", ")} for customer ${result.customer.id}.` };
    },
  },
  {
    name: "request_refund",
    title: "Request refund",
    description:
      "Request a refund for an order. Refunds are never executed immediately: this creates an approval request that a different, authorized manager must approve. Returns status pending_approval and an approvalId on success.",
    inputSchema: TOOL_INPUT_SCHEMAS.request_refund,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    execute: (ctx, args) => {
      const result = requestRefund(ctx, args);
      return {
        data: result,
        message: result.duplicate
          ? `This refund was already requested (approval ${result.approvalId}). Manager approval required.`
          : result.message,
        approvalId: result.approvalId,
        pending: true,
      };
    },
  },
  {
    name: "get_approval_status",
    title: "Get approval status",
    description: "Check the status of an approval request (pending, approved, rejected or invalidated).",
    inputSchema: TOOL_INPUT_SCHEMAS.get_approval_status,
    annotations: readOnly,
    execute: (ctx, args) => {
      const approval = getApprovalStatus(ctx, args);
      return { data: approval, message: `Approval ${approval.id} is ${approval.status}.`, approvalId: approval.id };
    },
  },
  {
    name: "get_audit_history",
    title: "Get audit history",
    description:
      "Retrieve recent security audit events, optionally for one order or customer. Visibility depends on role: support agents see only their own actions, managers see their team, administrators see everything.",
    inputSchema: TOOL_INPUT_SCHEMAS.get_audit_history,
    annotations: readOnly,
    execute: (ctx, args) => {
      const result = getAuditHistory(ctx, args);
      return { data: result, message: `${result.events.length} audit events. ${result.note}` };
    },
  },
];
