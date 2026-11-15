import type { ConversationItem, ModelClient, ModelRequest, ModelResponse } from "./model";

/**
 * Offline demo model — a deterministic, rule-based stand-in used when no OpenAI key is
 * configured. It is NOT an LLM: it maps a handful of phrasings to tool calls and
 * renders replies strictly from real tool results. It exists so the full
 * agent → MCP → authorization pipeline can be demonstrated and tested without credentials.
 */
export class OfflineModel implements ModelClient {
  readonly id = "offline-rules";
  readonly kind = "offline" as const;

  async generate({ items }: ModelRequest): Promise<ModelResponse> {
    const lastUserIndex = items.findLastIndex((i) => i.type === "message" && i.role === "user");
    const outputs = items.slice(lastUserIndex + 1).filter((i) => i.type === "function_call_output");
    if (outputs.length > 0) return { items: [assistant(describeResults(items.slice(lastUserIndex + 1)))] };

    const user = items[lastUserIndex];
    if (!user || user.type !== "message") return { items: [assistant(HELP)] };
    const call = planToolCall(user.content, items.slice(0, lastUserIndex), lastUserIndex);
    return { items: [typeof call === "string" ? assistant(call) : call] };
  }
}

const HELP =
  "I'm running in offline demo mode (rule-based, no LLM). Try: \"Show customer 1024\", \"Show me the orders for customer 1024\", " +
  "\"What's the status of order 5021?\", \"Refund €120 for order 5021\", \"Update the email for customer 1024 to new@example.com\", " +
  "\"Check approval apr_…\" or \"Show the audit history for order 5021\".";

const assistant = (content: string): ConversationItem => ({ type: "message", role: "assistant", content });

const ORDER_RE = /\border\s*(?:#|no\.?|number)?\s*(\d{3,})/i;
const CUSTOMER_RE = /\bcustomer\s*(?:#|no\.?|number)?\s*(\d{3,})/i;
const APPROVAL_RE = /\b(apr_[A-Za-z0-9_]+)\b/;
const AMOUNT_RE = /(?:€|\beur\s*)(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\b|euros?\b)/i;
const EMAIL_RE = /[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/;

function lastMentioned(history: ConversationItem[], key: "orderId" | "customerId", re: RegExp): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]!;
    if (item.type === "message" && item.role === "user") {
      const m = item.content.match(re);
      if (m) return Number(m[1]);
    }
    if (item.type === "function_call") {
      const value = (JSON.parse(item.arguments) as Record<string, unknown>)[key];
      if (typeof value === "number") return value;
    }
  }
  return undefined;
}

function planToolCall(text: string, history: ConversationItem[], seq: number): ConversationItem | string {
  const call = (name: string, args: Record<string, unknown>): ConversationItem => ({
    type: "function_call",
    callId: `offline_${seq}_${name}`,
    name,
    arguments: JSON.stringify(args),
  });
  const refersBack = /\b(this|that|the same)\s+(order|customer)\b/i.test(text);
  const orderId =
    numberFrom(text, ORDER_RE) ?? (refersBack ? lastMentioned(history, "orderId", ORDER_RE) : undefined);
  const customerId =
    numberFrom(text, CUSTOMER_RE) ?? (refersBack ? lastMentioned(history, "customerId", CUSTOMER_RE) : undefined);
  const amountMatch = text.match(AMOUNT_RE);
  const amount = amountMatch ? Number((amountMatch[1] ?? amountMatch[2])!.replace(",", ".")) : undefined;

  if (/\brefund/i.test(text) && !/\b(status|history|audit)\b/i.test(text)) {
    if (orderId === undefined || amount === undefined) {
      return "To request a refund I need one specific order ID and amount, for example \"Refund €120 for order 5021\". I won't act on bulk or open-ended refund requests.";
    }
    return call("request_refund", { orderId, amount, currency: "EUR", reason: "Requested via Gatekeeper agent console" });
  }
  const approvalId = text.match(APPROVAL_RE)?.[1];
  if (approvalId) return call("get_approval_status", { approvalId });
  if (/\b(audit|history)\b/i.test(text)) {
    return call("get_audit_history", {
      ...(orderId !== undefined ? { orderId } : customerId !== undefined ? { customerId } : {}),
      limit: 10,
    });
  }
  const email = text.match(EMAIL_RE)?.[0];
  if (/\b(update|change|set)\b/i.test(text) && /\bemail\b/i.test(text)) {
    if (customerId === undefined || !email) {
      return "To update an email address I need the customer ID and the new address, e.g. \"Update the email for customer 1024 to niamh@example.com\".";
    }
    return call("update_customer", { customerId, changes: { email } });
  }
  if (/\borders\b/i.test(text) && customerId !== undefined) return call("list_customer_orders", { customerId });
  if (orderId !== undefined) return call("get_order_status", { orderId });
  if (customerId !== undefined) return call("get_customer", { customerId });
  return HELP;
}

function numberFrom(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  return m ? Number(m[1]) : undefined;
}

interface ParsedResult {
  status: string;
  message: string;
  data?: any;
  approvalId?: string;
}

const eur = (n: number) => `€${n.toFixed(2)}`;

function describeResults(turnItems: ConversationItem[]): string {
  const names = new Map<string, string>();
  for (const item of turnItems) if (item.type === "function_call") names.set(item.callId, item.name);
  return turnItems
    .filter((i): i is Extract<ConversationItem, { type: "function_call_output" }> => i.type === "function_call_output")
    .map((o) => describe(names.get(o.callId) ?? "tool", parseOutput(o.output)))
    .join("\n\n");
}

function parseOutput(output: string): ParsedResult {
  try {
    const parsed = JSON.parse(output) as { result?: ParsedResult };
    return parsed.result ?? { status: "error", message: "The tool returned no result." };
  } catch {
    return { status: "error", message: output };
  }
}

function describe(tool: string, r: ParsedResult): string {
  switch (r.status) {
    case "denied":
      return `Gatekeeper denied this request: ${r.message}`;
    case "unauthenticated":
      return `I couldn't do that because no authenticated identity is available: ${r.message}`;
    case "invalid":
      return `The request was rejected as invalid: ${r.message}`;
    case "not_found":
    case "conflict":
    case "error":
      return r.message;
  }
  const d = r.data;
  switch (tool) {
    case "get_customer":
      return `**${d.name}** (customer ${d.id}) — account ${d.accountStatus}. Email: ${d.email}${d.phone ? `, phone: ${d.phone}` : ""}. Assigned representative: ${d.assignedRep.name}.`;
    case "list_customer_orders":
      return [
        `Customer ${d.customerId} (${d.customerName}) has ${d.orders.length} orders:`,
        ...d.orders.map(
          (o: any) =>
            `- Order ${o.id}: ${eur(o.amount)} — ${o.status}${o.refundedAmount ? `, ${eur(o.refundedAmount)} refunded` : ""}`,
        ),
      ].join("\n");
    case "get_order_status":
      return `Order ${d.id} is **${d.status}**: ${eur(d.amount)} total, ${eur(d.refundedAmount)} refunded, ${eur(d.refundableAmount)} still refundable${d.pendingRefundAmount ? ` (${eur(d.pendingRefundAmount)} awaiting approval)` : ""}.`;
    case "update_customer":
      return `Updated ${d.changedFields.join(", ")} for customer ${d.customer.id} (${d.customer.name}).`;
    case "request_refund":
      return d.duplicate
        ? `That refund was already requested — approval ${d.approvalId} is still **pending manager approval**. No new request was created.`
        : `I've submitted a refund request for ${eur(d.amount)} on order ${d.orderId}. It is **pending manager approval** (approval ${d.approvalId}). No money has moved yet.`;
    case "get_approval_status":
      return `Approval ${d.id} (${eur(d.amount)} refund on order ${d.orderId}, requested by ${d.requester.name}) is **${d.status}**${
        d.approver ? `, decided by ${d.approver.name}` : ""
      }${d.refundId ? `. Refund ${d.refundId} was executed.` : "."}`;
    case "get_audit_history":
      return [
        `${d.note} Showing ${d.events.length} event(s):`,
        ...d.events
          .slice(0, 10)
          .map(
            (e: any) =>
              `- ${e.timestamp.slice(0, 19).replace("T", " ")} · ${e.actorId ?? "anonymous"} · ${e.action}${e.resource ? ` on ${e.resource}` : ""} → ${e.decision}`,
          ),
      ].join("\n");
    default:
      return r.message;
  }
}
