import type { AccountStatus, OrderStatus, Role } from "@gatekeeper/database";
import type { Actor } from "../context";

/**
 * Gatekeeper's single source of authorization truth.
 *
 * `authorize()` is a pure function of (actor, operation, resource, context). It does not
 * read the database, call the model or accept anything the model can influence other
 * than the *requested* operation and arguments, which are treated as untrusted claims.
 */

export type Operation =
  | "customer.list"
  | "customer.read"
  | "customer.update"
  | "order.read"
  | "refund.request"
  | "approval.read"
  | "approval.approve"
  | "approval.reject"
  | "audit.read"
  | "trace.read";

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Operation>> = {
  support_agent: new Set<Operation>([
    "customer.list",
    "customer.read",
    "customer.update",
    "order.read",
    "refund.request",
    "approval.read",
    "audit.read",
    "trace.read",
  ]),
  manager: new Set<Operation>([
    "customer.list",
    "customer.read",
    "customer.update",
    "order.read",
    "refund.request",
    "approval.read",
    "approval.approve",
    "approval.reject",
    "audit.read",
    "trace.read",
  ]),
  admin: new Set<Operation>([
    "customer.list",
    "customer.read",
    "customer.update",
    "order.read",
    "refund.request",
    "approval.read",
    "approval.approve",
    "approval.reject",
    "audit.read",
    "trace.read",
  ]),
};

/** Explicit allowlist of customer fields each role may write. Anything else is rejected. */
export const WRITABLE_CUSTOMER_FIELDS: Record<Role, readonly string[]> = {
  support_agent: ["email", "phone"],
  manager: ["email", "phone"],
  admin: ["email", "phone", "accountStatus"],
};

export const REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  "paid",
  "shipped",
  "delivered",
  "partially_refunded",
];

export const ROLE_LABELS: Record<Role, string> = {
  support_agent: "Support Agent",
  manager: "Manager",
  admin: "Administrator",
};

/** Ownership facts about the customer a resource belongs to. Loaded server-side. */
export interface CustomerScope {
  customerId: number;
  assignedRepId: string;
  repTeamId: string | null;
  accountStatus: AccountStatus;
}

export interface OrderFacts {
  id: number;
  status: OrderStatus;
  currency: string;
  amountCents: number;
}

export type Resource =
  | { type: "customer"; scope: CustomerScope }
  | { type: "order"; scope: CustomerScope; order: OrderFacts }
  | {
      type: "approval";
      scope: CustomerScope;
      order: OrderFacts;
      approval: { id: string; requesterId: string; amountCents: number };
    }
  /** Collection-level operations (lists, audit, traces); row filtering is applied by the service. */
  | { type: "collection"; name: string };

export interface PolicyContext {
  changedFields?: string[];
  refund?: { amountCents: number; currency: string; refundableCents: number };
}

export type DecisionCode =
  | "allowed"
  | "approval_required"
  | "unauthenticated"
  | "role_not_permitted"
  | "not_assigned"
  | "outside_team"
  | "missing_context"
  | "field_not_writable"
  | "order_not_refundable"
  | "account_closed"
  | "currency_mismatch"
  | "amount_exceeds_refundable"
  | "self_approval"
  | "no_approval_authority"
  | "approval_limit_exceeded";

/** Codes caused by the *resource's* state rather than the actor — these invalidate pending approvals. */
export const RESOURCE_STATE_CODES: ReadonlySet<DecisionCode> = new Set<DecisionCode>([
  "order_not_refundable",
  "account_closed",
  "currency_mismatch",
  "amount_exceeds_refundable",
]);

export type PolicyCheckName = "identity" | "role" | "scope" | "restrictions" | "financial_limit" | "approval";

export interface PolicyCheck {
  name: PolicyCheckName;
  passed: boolean;
  detail: string;
}

export interface AuthorizationDecision {
  effect: "allow" | "deny" | "requires_approval";
  code: DecisionCode;
  reason: string;
  operation: Operation;
  checks: PolicyCheck[];
}

export interface AuthorizeInput {
  actor: Actor | null | undefined;
  operation: Operation;
  resource: Resource;
  context?: PolicyContext;
}

const euros = (cents: number) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);

export function authorize({ actor, operation, resource, context = {} }: AuthorizeInput): AuthorizationDecision {
  const checks: PolicyCheck[] = [];
  const pass = (name: PolicyCheckName, detail: string) => checks.push({ name, passed: true, detail });
  const deny = (name: PolicyCheckName, code: DecisionCode, reason: string): AuthorizationDecision => {
    checks.push({ name, passed: false, detail: reason });
    return { effect: "deny", code, reason, operation, checks };
  };

  // 1. Identity — fail closed when no trusted principal exists.
  if (!actor) return deny("identity", "unauthenticated", "No authenticated identity is available for this request.");
  pass("identity", `Authenticated as ${actor.name} (${actor.id})`);

  // 2. Role permissions.
  if (!ROLE_PERMISSIONS[actor.role]?.has(operation)) {
    return deny("role", "role_not_permitted", `The ${ROLE_LABELS[actor.role]} role cannot perform ${operation}.`);
  }
  pass("role", `${ROLE_LABELS[actor.role]} may perform ${operation}`);

  // 3. Resource ownership / assignment.
  if (resource.type !== "collection") {
    const isOwnApproval =
      operation === "approval.read" && resource.type === "approval" && resource.approval.requesterId === actor.id;
    const scopeDecision = isOwnApproval ? null : checkScope(actor, resource.scope);
    if (scopeDecision) return deny("scope", scopeDecision.code, scopeDecision.reason);
    pass("scope", isOwnApproval ? "Actor created this approval request" : scopeSummary(actor, resource.scope));
  }

  // 4. Operation-specific restrictions.
  if (operation === "customer.update") {
    const fields = context.changedFields;
    if (!fields || fields.length === 0) return deny("restrictions", "missing_context", "No fields to update were specified.");
    const allowed = WRITABLE_CUSTOMER_FIELDS[actor.role];
    const blocked = fields.filter((f) => !allowed.includes(f));
    if (blocked.length > 0) {
      return deny(
        "restrictions",
        "field_not_writable",
        `The ${ROLE_LABELS[actor.role]} role cannot change: ${blocked.join(", ")}. Writable fields: ${allowed.join(", ")}.`,
      );
    }
    pass("restrictions", `Fields within allowlist: ${fields.join(", ")}`);
  }

  if (operation === "refund.request" || operation === "approval.approve") {
    if (resource.type !== "order" && resource.type !== "approval") {
      return deny("restrictions", "missing_context", "Refunds must target an order.");
    }
    const refund = context.refund;
    if (!refund) return deny("restrictions", "missing_context", "Refund details are missing.");
    const { order, scope } = resource;
    if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) {
      return deny("restrictions", "order_not_refundable", `Order ${order.id} is ${order.status} and cannot be refunded.`);
    }
    if (scope.accountStatus === "closed") {
      return deny("restrictions", "account_closed", `Customer ${scope.customerId}'s account is closed.`);
    }
    if (refund.currency !== order.currency) {
      return deny("restrictions", "currency_mismatch", `Order ${order.id} is in ${order.currency}, not ${refund.currency}.`);
    }
    if (refund.amountCents > refund.refundableCents) {
      return deny(
        "restrictions",
        "amount_exceeds_refundable",
        `Requested ${euros(refund.amountCents)} exceeds the refundable balance of ${euros(refund.refundableCents)} for order ${order.id}.`,
      );
    }
    pass("restrictions", `Order ${order.id} is refundable (${euros(refund.refundableCents)} available)`);
  }

  if ((operation === "approval.approve" || operation === "approval.reject") && resource.type === "approval") {
    if (resource.approval.requesterId === actor.id) {
      return deny("approval", "self_approval", "You cannot decide on an approval request you created.");
    }
    pass("approval", "Approver is not the requester");
  }

  // 5. Financial limits.
  if (operation === "approval.approve" && resource.type === "approval") {
    const limit = actor.refundApprovalLimitCents;
    if (limit === null) {
      return deny("financial_limit", "no_approval_authority", `${actor.name} has no refund approval authority.`);
    }
    if (resource.approval.amountCents > limit) {
      return deny(
        "financial_limit",
        "approval_limit_exceeded",
        `${euros(resource.approval.amountCents)} exceeds ${actor.name}'s approval limit of ${euros(limit)}.`,
      );
    }
    pass("financial_limit", `${euros(resource.approval.amountCents)} is within the ${euros(limit)} limit`);
  }

  // 6. Approval requirements — every refund needs a second person (four-eyes principle).
  if (operation === "refund.request") {
    checks.push({ name: "approval", passed: true, detail: "Refunds require approval by a different, authorized user" });
    return {
      effect: "requires_approval",
      code: "approval_required",
      reason: "Manager approval required.",
      operation,
      checks,
    };
  }

  return { effect: "allow", code: "allowed", reason: "Permitted by policy.", operation, checks };
}

function checkScope(actor: Actor, scope: CustomerScope): { code: DecisionCode; reason: string } | null {
  switch (actor.role) {
    case "admin":
      return null;
    case "manager":
      return actor.teamId !== null && actor.teamId === scope.repTeamId
        ? null
        : { code: "outside_team", reason: `Customer ${scope.customerId} is not managed by your team.` };
    case "support_agent":
      return scope.assignedRepId === actor.id
        ? null
        : { code: "not_assigned", reason: `You are not assigned to customer ${scope.customerId}.` };
    default:
      return { code: "role_not_permitted", reason: "Unknown role." };
  }
}

function scopeSummary(actor: Actor, scope: CustomerScope): string {
  if (actor.role === "admin") return "Administrators can access all records";
  if (actor.role === "manager") return `Customer ${scope.customerId} belongs to team ${scope.repTeamId}`;
  return `Assigned to customer ${scope.customerId}`;
}
