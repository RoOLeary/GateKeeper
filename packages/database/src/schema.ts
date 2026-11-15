import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const ROLES = ["support_agent", "manager", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ACCOUNT_STATUSES = ["active", "suspended", "closed"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ORDER_STATUSES = [
  "paid",
  "shipped",
  "delivered",
  "cancelled",
  "partially_refunded",
  "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "invalidated"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const AUDIT_DECISIONS = ["allow", "deny", "requires_approval", "error"] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

export const TRACE_OUTCOMES = ["ok", "denied", "pending", "error", "info"] as const;
export type TraceOutcome = (typeof TRACE_OUTCOMES)[number];

const timestamp = (name: string) => text(name).notNull();

/** Fictional staff members. Customer assignment lives on `customers.assignedRepId`. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role", { enum: ROLES }).notNull(),
  teamId: text("team_id"),
  /** Maximum refund (in cents) this user may approve. Null means no approval rights. */
  refundApprovalLimitCents: integer("refund_approval_limit_cents"),
});

export const customers = sqliteTable(
  "customers",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    assignedRepId: text("assigned_rep_id")
      .notNull()
      .references(() => users.id),
    accountStatus: text("account_status", { enum: ACCOUNT_STATUSES }).notNull(),
    updatedAt: timestamp("updated_at"),
  },
  (t) => [index("customers_rep_idx").on(t.assignedRepId)],
);

export const orders = sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    status: text("status", { enum: ORDER_STATUSES }).notNull(),
    /** Incremented on every state change; used to detect stale pending operations. */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (t) => [index("orders_customer_idx").on(t.customerId)],
);

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    operation: text("operation", { enum: ["refund.create"] }).notNull(),
    resourceType: text("resource_type", { enum: ["order"] }).notNull(),
    resourceId: text("resource_id").notNull(),
    /** JSON-encoded, re-validated with Zod before execution. */
    requestedArgs: text("requested_args").notNull(),
    amountCents: integer("amount_cents").notNull(),
    requesterId: text("requester_id")
      .notNull()
      .references(() => users.id),
    status: text("status", { enum: APPROVAL_STATUSES }).notNull(),
    approverId: text("approver_id").references(() => users.id),
    decisionReason: text("decision_reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    resourceVersionAtRequest: integer("resource_version_at_request").notNull(),
    correlationId: text("correlation_id"),
    resultRefundId: text("result_refund_id"),
    createdAt: timestamp("created_at"),
    decidedAt: text("decided_at"),
    executedAt: text("executed_at"),
  },
  (t) => [
    uniqueIndex("approval_requester_idempotency_uq").on(t.requesterId, t.idempotencyKey),
    index("approval_status_idx").on(t.status),
  ],
);

export const refunds = sqliteTable("refunds", {
  id: text("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => orders.id),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  status: text("status", { enum: ["completed"] }).notNull(),
  reason: text("reason").notNull(),
  requestedBy: text("requested_by")
    .notNull()
    .references(() => users.id),
  approvedBy: text("approved_by")
    .notNull()
    .references(() => users.id),
  /** One approval can produce at most one refund. */
  approvalRequestId: text("approval_request_id").unique(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at"),
});

/** Security audit trail: who attempted what, against which resource, and the decision. */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    timestamp: timestamp("timestamp"),
    actorId: text("actor_id"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    decision: text("decision", { enum: AUDIT_DECISIONS }).notNull(),
    reason: text("reason"),
    correlationId: text("correlation_id").notNull(),
    channel: text("channel").notNull(),
    metadata: text("metadata"),
  },
  (t) => [
    index("audit_correlation_idx").on(t.correlationId),
    index("audit_resource_idx").on(t.resourceType, t.resourceId),
  ],
);

/** Diagnostic execution traces, kept separate from the security audit trail. */
export const traceEvents = sqliteTable(
  "trace_events",
  {
    id: text("id").primaryKey(),
    timestamp: timestamp("timestamp"),
    correlationId: text("correlation_id").notNull(),
    sessionId: text("session_id"),
    actorId: text("actor_id"),
    type: text("type").notNull(),
    name: text("name"),
    outcome: text("outcome", { enum: TRACE_OUTCOMES }).notNull(),
    durationMs: integer("duration_ms"),
    attributes: text("attributes"),
  },
  (t) => [index("trace_correlation_idx").on(t.correlationId)],
);

/** Server-managed demo sessions. Only a SHA-256 hash of the cookie token is stored. */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at"),
  expiresAt: timestamp("expires_at"),
});

/** Agent conversation history, scoped to a session. */
export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["model_item", "display"] }).notNull(),
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [index("agent_messages_session_idx").on(t.sessionId)],
);

export type User = typeof users.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type TraceEvent = typeof traceEvents.$inferSelect;
export type Session = typeof sessions.$inferSelect;
