import type { z } from "zod";
import { recordAudit } from "@gatekeeper/observability";
import type { ExecutionContext } from "../context";
import { ServiceError } from "../errors";
import { authorize, type AuthorizationDecision, type Operation, type PolicyContext, type Resource } from "./policy";

interface EnforceInput {
  operation: Operation;
  resource: Resource;
  context?: PolicyContext;
  audit?: { resourceType?: string; resourceId?: string | number; metadata?: Record<string, unknown> };
}

function auditTarget(resource: Resource): { type: string; id?: string | number } {
  switch (resource.type) {
    case "customer":
      return { type: "customer", id: resource.scope.customerId };
    case "order":
      return { type: "order", id: resource.order.id };
    case "approval":
      return { type: "approval", id: resource.approval.id };
    case "collection":
      return { type: resource.name };
  }
}

/**
 * Evaluates policy, records the decision in the audit trail and diagnostic trace,
 * and throws on denial. Every service operation passes through here.
 */
export function enforce(ctx: ExecutionContext, input: EnforceInput): AuthorizationDecision {
  const decision = authorize({
    actor: ctx.actor,
    operation: input.operation,
    resource: input.resource,
    context: input.context,
  });
  const target = auditTarget(input.resource);
  const resourceType = input.audit?.resourceType ?? target.type;
  const resourceId = input.audit?.resourceId ?? target.id;

  recordAudit(ctx.db, {
    actor: ctx.actor,
    action: input.operation,
    resourceType,
    resourceId,
    decision: decision.effect,
    reason: decision.reason,
    correlationId: ctx.correlationId,
    channel: ctx.channel,
    metadata: { code: decision.code, ...input.audit?.metadata },
  });

  ctx.tracer?.event("authz.evaluated", {
    name: input.operation,
    outcome: decision.effect === "allow" ? "ok" : decision.effect === "deny" ? "denied" : "pending",
    attributes: {
      effect: decision.effect,
      code: decision.code,
      reason: decision.reason,
      resource: resourceId === undefined ? resourceType : `${resourceType}:${resourceId}`,
      checks: decision.checks,
    },
  });

  if (decision.effect === "deny") {
    throw new ServiceError(decision.code === "unauthenticated" ? "unauthenticated" : "forbidden", decision.reason, decision);
  }
  return decision;
}

/** Fails closed before any data is touched when no trusted identity exists. */
export function requireActor(ctx: ExecutionContext, operation: Operation): asserts ctx is ExecutionContext & {
  actor: NonNullable<ExecutionContext["actor"]>;
} {
  if (!ctx.actor) enforce(ctx, { operation, resource: { type: "collection", name: operation.split(".")[0]! } });
}

/** Validates untrusted input. Rejections are audited, then surfaced as safe errors. */
export function parseInput<S extends z.ZodType>(
  ctx: ExecutionContext,
  operation: Operation,
  schema: S,
  raw: unknown,
): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const message = result.error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
  recordAudit(ctx.db, {
    actor: ctx.actor,
    action: operation,
    decision: "deny",
    reason: "Invalid input",
    correlationId: ctx.correlationId,
    channel: ctx.channel,
    metadata: { code: "invalid_input", issues: message },
  });
  ctx.tracer?.event("input.rejected", { name: operation, outcome: "denied", attributes: { issues: message } });
  throw new ServiceError("invalid_input", `Invalid arguments: ${message}`);
}

/** Records a not-found outcome so probing for records is visible in the audit trail. */
export function notFound(ctx: ExecutionContext, operation: Operation, resourceType: string, resourceId: string | number): never {
  recordAudit(ctx.db, {
    actor: ctx.actor,
    action: operation,
    resourceType,
    resourceId,
    decision: "deny",
    reason: "Resource not found",
    correlationId: ctx.correlationId,
    channel: ctx.channel,
    metadata: { code: "not_found" },
  });
  ctx.tracer?.event("authz.evaluated", {
    name: operation,
    outcome: "denied",
    attributes: { code: "not_found", resource: `${resourceType}:${resourceId}` },
  });
  const label = resourceType.charAt(0).toUpperCase() + resourceType.slice(1);
  throw new ServiceError("not_found", `${label} ${resourceId} was not found.`);
}
