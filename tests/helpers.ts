import { createSeededDatabase, type Database } from "@gatekeeper/database";
import { loadActor, type ExecutionContext } from "@gatekeeper/core";
import { newCorrelationId, Tracer } from "@gatekeeper/observability";

export type DemoUserId = "u_alice" | "u_carl" | "u_bob" | "u_maya" | "u_sam" | "u_ada";

export function createTestEnv() {
  const db = createSeededDatabase();
  const ctx = (userId: DemoUserId | null, correlationId = newCorrelationId()): ExecutionContext => ({
    db,
    actor: loadActor(db, userId),
    correlationId,
    channel: "web",
    tracer: new Tracer(db, { correlationId, actorId: userId }),
  });
  return { db, ctx };
}

export function expectServiceError(fn: () => unknown, code: string): Error & { code: string } {
  try {
    fn();
  } catch (error) {
    const e = error as Error & { code: string };
    if (e.code !== code) throw new Error(`Expected ServiceError(${code}) but got ${e.code ?? e.name}: ${e.message}`);
    return e;
  }
  throw new Error(`Expected ServiceError(${code}) but call succeeded`);
}

export type { Database };
