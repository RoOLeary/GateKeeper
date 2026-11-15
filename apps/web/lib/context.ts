import "server-only";
import type { ExecutionContext } from "@gatekeeper/core";
import { getDatabase } from "@gatekeeper/database";
import { newCorrelationId, Tracer } from "@gatekeeper/observability";
import type { WebSession } from "./session";

/**
 * Execution context for direct (non-agent) web operations, bound to the trusted session.
 * Page reads are audited but not traced; user actions pass `trace: true` so they appear
 * in the execution viewer alongside agent runs.
 */
export function webContext(session: WebSession | null, options: { trace?: boolean } = {}): ExecutionContext {
  const db = getDatabase();
  const correlationId = newCorrelationId();
  return {
    db,
    actor: session?.actor ?? null,
    correlationId,
    sessionId: session?.sessionId ?? null,
    channel: "web",
    tracer: options.trace
      ? new Tracer(db, { correlationId, sessionId: session?.sessionId ?? null, actorId: session?.actor.id ?? null })
      : undefined,
  };
}
