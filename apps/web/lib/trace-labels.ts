import type { TraceEvent } from "@gatekeeper/database";

export function traceLabel(event: TraceEvent, attrs: Record<string, any>): string {
  switch (event.type) {
    case "request.received":
      return event.name ? `Web action received: ${event.name}` : "User request received";
    case "agent.tools_discovered":
      return `Agent discovered ${attrs.count ?? ""} MCP tools`;
    case "agent.model_call":
      return `Model call #${attrs.iteration ?? "?"} (${event.name})`;
    case "agent.tool_selected":
      return `Agent selected ${event.name}`;
    case "agent.tool_blocked":
      return `Agent guard blocked ${event.name}`;
    case "agent.tool_failed":
      return `Tool call failed: ${event.name}`;
    case "mcp.tool_invoked":
      return `MCP tool invoked: ${event.name}`;
    case "input.rejected":
      return "Input validation rejected arguments";
    case "authz.evaluated":
      return event.outcome === "pending"
        ? "Authorization policy evaluated → approval required"
        : `Authorization policy evaluated → ${event.outcome === "ok" ? "allowed" : "denied"}`;
    case "approval.persisted":
      return "Approval request persisted";
    case "approval.replayed":
      return "Idempotent replay — existing approval returned";
    case "approval.executed":
      return "Approval executed — refund issued exactly once";
    case "approval.rejected":
      return "Approval rejected";
    case "approval.invalidated":
      return "Approval invalidated (resource state changed)";
    case "approval.replay_blocked":
      return "Replay blocked — approval already decided";
    case "mcp.tool_completed":
      return `MCP tool completed: ${event.name} → ${attrs.status ?? event.outcome}`;
    case "agent.reply_corrected":
      return "Reply guard corrected an inaccurate claim";
    case "agent.response_generated":
      return "Agent response generated";
    default:
      return event.type;
  }
}

export function traceDetail(event: TraceEvent, attrs: Record<string, any>): string | null {
  switch (event.type) {
    case "request.received":
      return attrs.preview ? `“${attrs.preview}”` : null;
    case "authz.evaluated":
      return [event.name, attrs.resource, attrs.code, attrs.reason].filter(Boolean).join(" · ");
    case "agent.tool_selected":
      return attrs.arguments ? JSON.stringify(attrs.arguments) : null;
    case "agent.tool_blocked":
    case "approval.invalidated":
      return attrs.reason ?? null;
    case "mcp.tool_completed":
      return attrs.message ?? null;
    case "approval.persisted":
    case "approval.executed":
      return [event.name, attrs.refundId, attrs.amount !== undefined ? `€${attrs.amount}` : null].filter(Boolean).join(" · ");
    case "agent.response_generated":
      return `${attrs.toolCalls ?? 0} tool call(s) · ${attrs.stopReason ?? ""}`;
    case "input.rejected":
      return attrs.issues ?? null;
    default:
      return null;
  }
}
