import {
  agentMessages,
  approvalRequests,
  auditEvents,
  customers,
  orders,
  refunds,
  sessions,
  traceEvents,
  users,
} from "./schema";
import { migrateDatabase, openDatabase, type Database } from "./client";

/** All seed timestamps are fixed so demos and tests are reproducible. */
const at = (iso: string) => new Date(iso).toISOString();

export const SEED_USERS = [
  { id: "u_alice", name: "Alice Byrne", role: "support_agent", teamId: "north", refundApprovalLimitCents: null },
  { id: "u_carl", name: "Carl Duffy", role: "support_agent", teamId: "north", refundApprovalLimitCents: null },
  { id: "u_bob", name: "Bob Okafor", role: "support_agent", teamId: "south", refundApprovalLimitCents: null },
  { id: "u_maya", name: "Maya Chen", role: "manager", teamId: "north", refundApprovalLimitCents: 50_000 },
  { id: "u_sam", name: "Sam Rivera", role: "manager", teamId: "south", refundApprovalLimitCents: 20_000 },
  { id: "u_ada", name: "Ada Quinn", role: "admin", teamId: null, refundApprovalLimitCents: 1_000_000 },
] as const satisfies (typeof users.$inferInsert)[];

const SEED_CUSTOMERS: (typeof customers.$inferInsert)[] = [
  { id: 1024, name: "Niamh Kelly", email: "niamh.kelly@example.com", phone: "+353 1 555 0124", assignedRepId: "u_alice", accountStatus: "active", updatedAt: at("2026-09-01T09:00:00Z") },
  { id: 1025, name: "Oisín Murphy", email: "oisin.murphy@example.com", phone: "+353 1 555 0125", assignedRepId: "u_alice", accountStatus: "active", updatedAt: at("2026-09-01T09:00:00Z") },
  { id: 1026, name: "Priya Shah", email: "priya.shah@example.com", phone: "+44 20 5550 1026", assignedRepId: "u_bob", accountStatus: "active", updatedAt: at("2026-09-01T09:00:00Z") },
  { id: 1027, name: "Lukas Weber", email: "lukas.weber@example.com", phone: null, assignedRepId: "u_bob", accountStatus: "suspended", updatedAt: at("2026-09-01T09:00:00Z") },
  { id: 1028, name: "Sofia Rossi", email: "sofia.rossi@example.com", phone: "+39 06 5550 1028", assignedRepId: "u_carl", accountStatus: "active", updatedAt: at("2026-09-01T09:00:00Z") },
  { id: 1029, name: "Tomás García", email: "tomas.garcia@example.com", phone: null, assignedRepId: "u_carl", accountStatus: "closed", updatedAt: at("2026-09-01T09:00:00Z") },
];

const order = (
  id: number,
  customerId: number,
  amountCents: number,
  status: (typeof orders.$inferInsert)["status"],
  createdAt: string,
): typeof orders.$inferInsert => ({
  id,
  customerId,
  amountCents,
  currency: "EUR",
  status,
  version: 1,
  createdAt: at(createdAt),
  updatedAt: at(createdAt),
});

const SEED_ORDERS = [
  order(5021, 1024, 24_000, "delivered", "2026-10-02T10:15:00Z"),
  order(5022, 1024, 8_000, "shipped", "2026-10-12T14:40:00Z"),
  order(5023, 1025, 125_000, "delivered", "2026-09-20T08:05:00Z"),
  order(5024, 1026, 6_000, "delivered", "2026-10-05T16:30:00Z"),
  order(5025, 1026, 90_000, "partially_refunded", "2026-09-28T11:00:00Z"),
  order(5026, 1027, 3_500, "delivered", "2026-10-08T09:45:00Z"),
  order(5027, 1028, 4_500, "delivered", "2026-10-10T13:20:00Z"),
  order(5028, 1028, 30_000, "cancelled", "2026-10-11T17:55:00Z"),
  order(5029, 1029, 9_900, "delivered", "2026-08-30T12:00:00Z"),
];

const SEED_APPROVALS: (typeof approvalRequests.$inferInsert)[] = [
  {
    id: "apr_seed_0001",
    operation: "refund.create",
    resourceType: "order",
    resourceId: "5025",
    requestedArgs: JSON.stringify({ orderId: 5025, amount: 150, currency: "EUR", reason: "Damaged item on arrival" }),
    amountCents: 15_000,
    requesterId: "u_bob",
    status: "approved",
    approverId: "u_sam",
    decisionReason: "Photos confirmed damage",
    idempotencyKey: "seed-refund-5025",
    resourceVersionAtRequest: 1,
    correlationId: "seed",
    resultRefundId: "rf_seed_0001",
    createdAt: at("2026-10-01T10:00:00Z"),
    decidedAt: at("2026-10-01T11:30:00Z"),
    executedAt: at("2026-10-01T11:30:00Z"),
  },
  {
    id: "apr_seed_0002",
    operation: "refund.create",
    resourceType: "order",
    resourceId: "5027",
    requestedArgs: JSON.stringify({ orderId: 5027, amount: 45, currency: "EUR", reason: "Order arrived two weeks late" }),
    amountCents: 4_500,
    requesterId: "u_carl",
    status: "pending",
    idempotencyKey: "seed-refund-5027",
    resourceVersionAtRequest: 1,
    correlationId: "seed",
    createdAt: at("2026-10-14T15:00:00Z"),
  },
];

const SEED_REFUNDS: (typeof refunds.$inferInsert)[] = [
  {
    id: "rf_seed_0001",
    orderId: 5025,
    amountCents: 15_000,
    currency: "EUR",
    status: "completed",
    reason: "Damaged item on arrival",
    requestedBy: "u_bob",
    approvedBy: "u_sam",
    approvalRequestId: "apr_seed_0001",
    idempotencyKey: "seed-refund-5025",
    createdAt: at("2026-10-01T11:30:00Z"),
  },
];

/** Replaces all data with the deterministic demo dataset. */
export function seedDatabase(db: Database): void {
  db.transaction((tx) => {
    tx.delete(agentMessages).run();
    tx.delete(sessions).run();
    tx.delete(traceEvents).run();
    tx.delete(auditEvents).run();
    tx.delete(refunds).run();
    tx.delete(approvalRequests).run();
    tx.delete(orders).run();
    tx.delete(customers).run();
    tx.delete(users).run();

    tx.insert(users).values([...SEED_USERS]).run();
    tx.insert(customers).values(SEED_CUSTOMERS).run();
    tx.insert(orders).values(SEED_ORDERS).run();
    tx.insert(approvalRequests).values(SEED_APPROVALS).run();
    tx.insert(refunds).values(SEED_REFUNDS).run();
  });
}

/** Fresh, migrated and seeded database — in memory by default. Used by tests. */
export function createSeededDatabase(filename = ":memory:"): Database {
  const db = openDatabase(filename);
  migrateDatabase(db);
  seedDatabase(db);
  return db;
}
