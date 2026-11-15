import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MUTATING_TOOLS, TOOL_INPUT_SCHEMAS, type ToolName } from "@gatekeeper/core";
import type { ToolResult } from "@gatekeeper/mcp-server";
import type { ToolSpec } from "./model";

/**
 * Discovers tools from the MCP server. Only tools the agent knows how to validate
 * are exposed to the model — an unexpected tool appearing on the server is ignored.
 */
export async function discoverTools(client: Client): Promise<ToolSpec[]> {
  const { tools } = await client.listTools();
  return tools
    .filter((t) => Object.hasOwn(TOOL_INPUT_SCHEMAS, t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? t.title ?? t.name,
      parameters: t.inputSchema as Record<string, unknown>,
    }));
}

export function isKnownTool(name: string): name is ToolName {
  return Object.hasOwn(TOOL_INPUT_SCHEMAS, name);
}

export type PreflightResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

/** Validates model-proposed arguments with the same Zod schemas the server enforces. */
export function preflight(name: ToolName, rawArguments: string, idempotencySeed: string): PreflightResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || "{}");
  } catch {
    return { ok: false, message: "Tool arguments were not valid JSON." };
  }
  const result = TOOL_INPUT_SCHEMAS[name].safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      message: result.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; "),
    };
  }
  const args = { ...(parsed as Record<string, unknown>) };
  // Non-idempotent operations always carry an idempotency key, derived deterministically so
  // that a model repeating the same call within a run cannot create a duplicate request.
  if (name === "request_refund" && !args.idempotencyKey) {
    args.idempotencyKey = `agent-${createHash("sha256")
      .update(`${idempotencySeed}:${canonical(args)}`)
      .digest("hex")
      .slice(0, 32)}`;
  }
  return { ok: true, args };
}

export function isMutating(name: ToolName): boolean {
  return MUTATING_TOOLS.has(name);
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().map((k) => [k, value[k]]));
}

/** Calls an MCP tool once (never retried) and normalizes the result envelope. */
export async function callMcpTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolResult> {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const structured = res.structuredContent as ToolResult | undefined;
  if (structured && typeof structured.status === "string") return structured;
  const text = Array.isArray(res.content) ? (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join(" ") : "";
  return {
    status: res.isError ? "invalid" : "error",
    message: text || "The tool returned no structured result.",
    correlationId: "",
  };
}
