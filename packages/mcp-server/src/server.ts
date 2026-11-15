import { performance } from "node:perf_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isServiceError, loadActor, type AuthorizationDecision, type ExecutionContext } from "@gatekeeper/core";
import type { Database } from "@gatekeeper/database";
import { logger, newCorrelationId, recordAudit, Tracer, type Channel } from "@gatekeeper/observability";
import { TOOL_DEFINITIONS, type ToolDefinition } from "./tools/definitions";
import { ToolResultSchema, type ToolResult, type ToolStatus } from "./tools/result";

/**
 * The identity a server instance acts for. It is fixed by trusted code when the
 * server is constructed — stdio binds it from operator configuration, the web app
 * binds it from the server-side session. Nothing in a tool call can change it.
 */
export interface TrustedPrincipal {
  /** User ID, or `null` when no identity could be established (every call then fails closed). */
  userId: string | null;
  sessionId?: string | null;
}

export interface GatekeeperServerOptions {
  db: Database;
  principal: TrustedPrincipal;
  channel: Channel;
  /** Correlation ID shared with the caller (e.g. one agent run). Generated per call when omitted. */
  correlationId?: string;
}

const STATUS_BY_CODE: Record<string, ToolStatus> = {
  unauthenticated: "unauthenticated",
  forbidden: "denied",
  not_found: "not_found",
  invalid_input: "invalid",
  conflict: "conflict",
};

export const SERVER_INFO = { name: "gatekeeper", version: "0.1.0" } as const;

export function createGatekeeperMcpServer(options: GatekeeperServerOptions): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Gatekeeper customer-operations tools. Identity is bound by the server; never pass user IDs or roles. " +
      "Every call is authorized independently. Refunds always require human approval.",
  });

  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: ToolResultSchema,
        annotations: tool.annotations,
      },
      async (args: unknown) => invokeTool(options, tool, args),
    );
  }
  return server;
}

async function invokeTool(options: GatekeeperServerOptions, tool: ToolDefinition, args: unknown): Promise<CallToolResult> {
  const { db, principal, channel } = options;
  const correlationId = options.correlationId ?? newCorrelationId();
  // Resolve the actor fresh on every call so role changes or removed users take effect immediately.
  const actor = loadActor(db, principal.userId);
  const tracer = new Tracer(db, { correlationId, sessionId: principal.sessionId ?? null, actorId: actor?.id ?? principal.userId });
  let lastDecision: AuthorizationDecision | undefined;
  const ctx: ExecutionContext = {
    db,
    actor,
    correlationId,
    sessionId: principal.sessionId ?? null,
    channel,
    tracer,
    onDecision: (d) => (lastDecision = d),
  };

  const started = performance.now();
  tracer.event("mcp.tool_invoked", { name: tool.name, attributes: { arguments: args, channel } });

  let result: ToolResult;
  try {
    const out = tool.execute(ctx, args);
    result = {
      status: out.pending ? "pending_approval" : "ok",
      message: out.message,
      data: out.data,
      approvalId: out.approvalId,
      authorization: summarize(lastDecision),
      correlationId,
    };
  } catch (error) {
    if (isServiceError(error)) {
      result = {
        status: STATUS_BY_CODE[error.code] ?? "error",
        message: error.message,
        authorization: summarize(error.decision ?? lastDecision),
        correlationId,
      };
    } else {
      logger.error("mcp.tool_failed", { tool: tool.name, correlationId, error: String(error) });
      recordAudit(db, {
        actor,
        action: `tool.${tool.name}`,
        decision: "error",
        reason: "Unexpected server error",
        correlationId,
        channel,
      });
      result = { status: "error", message: "An internal error occurred. No changes were made.", correlationId };
    }
  }

  const durationMs = performance.now() - started;
  tracer.event("mcp.tool_completed", {
    name: tool.name,
    outcome: outcomeFor(result.status),
    durationMs,
    attributes: { status: result.status, message: result.message, approvalId: result.approvalId },
  });

  const isError = !["ok", "pending_approval"].includes(result.status);
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
  };
}

function summarize(decision: AuthorizationDecision | undefined): ToolResult["authorization"] {
  return decision ? { effect: decision.effect, code: decision.code, reason: decision.reason } : undefined;
}

function outcomeFor(status: ToolStatus) {
  if (status === "ok") return "ok" as const;
  if (status === "pending_approval") return "pending" as const;
  if (status === "error") return "error" as const;
  return "denied" as const;
}
