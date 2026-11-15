import { eq } from "drizzle-orm";
import { users, type Database, type Role } from "@gatekeeper/database";
import type { Channel, Tracer } from "@gatekeeper/observability";

/** An authenticated principal, always loaded from the database — never from model or client input. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
  teamId: string | null;
  refundApprovalLimitCents: number | null;
}

/**
 * Everything a service needs to know about *who* is calling and *how*.
 * Built by trusted transport code (web session, MCP server binding), never by the agent.
 */
export interface ExecutionContext {
  db: Database;
  /** `null` means no trusted identity was established; every operation fails closed. */
  actor: Actor | null;
  correlationId: string;
  sessionId?: string | null;
  channel: Channel;
  tracer?: Tracer;
}

export function loadActor(db: Database, userId: string | null | undefined): Actor | null {
  if (!userId) return null;
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    teamId: user.teamId,
    refundApprovalLimitCents: user.refundApprovalLimitCents,
  };
}
