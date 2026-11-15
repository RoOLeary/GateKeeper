import { performance } from "node:perf_hooks";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolResult } from "@gatekeeper/mcp-server";
import type { Tracer } from "@gatekeeper/observability";
import type { ConversationItem, ModelClient, ToolSpec } from "./model";
import { wrapToolOutput } from "./prompt";
import { callMcpTool, isKnownTool, isMutating, preflight } from "./tools";

export interface AgentLimits {
  /** Maximum MCP tool executions per user turn. */
  maxToolCalls: number;
  /** Maximum model round-trips per user turn. */
  maxModelCalls: number;
  modelTimeoutMs: number;
  toolTimeoutMs: number;
  /** Wall-clock budget for the whole turn. */
  runTimeoutMs: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxToolCalls: 6,
  maxModelCalls: 8,
  modelTimeoutMs: 45_000,
  toolTimeoutMs: 10_000,
  runTimeoutMs: 90_000,
};

export interface ToolCallRecord {
  callId: string;
  name: string;
  arguments: Record<string, unknown> | string;
  /** False when the call was blocked before reaching the MCP server. */
  executed: boolean;
  status: ToolResult["status"] | "blocked";
  message: string;
  authorization?: ToolResult["authorization"];
  approvalId?: string;
  durationMs: number;
}

export type StopReason = "completed" | "tool_limit" | "model_limit" | "timeout" | "model_error";

export interface TurnResult {
  reply: string;
  newItems: ConversationItem[];
  toolCalls: ToolCallRecord[];
  stopReason: StopReason;
  guardNotes: string[];
}

export interface TurnInput {
  model: ModelClient;
  mcp: Client;
  tools: ToolSpec[];
  instructions: string;
  history: ConversationItem[];
  userMessage: string;
  limits?: Partial<AgentLimits>;
  tracer?: Tracer;
  /** Seed for deterministic idempotency keys (unique per run). */
  idempotencySeed: string;
}

class TimeoutError extends Error {}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(`Timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One user turn of the tool-calling loop:
 *   model → (tool calls → MCP → results)* → final answer
 * bounded by tool-call, model-call and wall-clock limits. Tool results are only ever
 * produced by real MCP calls; the model never supplies them.
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const { tracer } = input;
  const deadline = Date.now() + limits.runTimeoutMs;
  const userItem: ConversationItem = { type: "message", role: "user", content: input.userMessage };
  const items: ConversationItem[] = [...input.history, userItem];
  const newItems: ConversationItem[] = [userItem];
  const toolCalls: ToolCallRecord[] = [];
  let toolBudgetExhausted = false;

  const push = (...added: ConversationItem[]) => {
    items.push(...added);
    newItems.push(...added);
  };

  for (let modelCall = 0; modelCall < limits.maxModelCalls; modelCall++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return finish("timeout");

    // Once the tool budget is spent, the model gets one final call without tools.
    const offeredTools = toolBudgetExhausted ? [] : input.tools;
    const started = performance.now();
    let output: ConversationItem[];
    try {
      const response = await withTimeout(Math.min(limits.modelTimeoutMs, remaining), (signal) =>
        input.model.generate({ instructions: input.instructions, items, tools: offeredTools, signal }),
      );
      output = response.items;
      tracer?.event("agent.model_call", {
        name: input.model.id,
        outcome: "ok",
        durationMs: performance.now() - started,
        attributes: { iteration: modelCall + 1, toolsOffered: offeredTools.length },
      });
    } catch (error) {
      const timedOut = error instanceof TimeoutError;
      tracer?.event("agent.model_call", {
        name: input.model.id,
        outcome: "error",
        durationMs: performance.now() - started,
        attributes: { iteration: modelCall + 1, error: timedOut ? "timeout" : errorName(error) },
      });
      return finish(timedOut ? "timeout" : "model_error");
    }

    push(...output);
    const calls = output.filter((i): i is Extract<ConversationItem, { type: "function_call" }> => i.type === "function_call");
    if (calls.length === 0) return finish("completed");
    if (toolBudgetExhausted) return finish("tool_limit");

    for (const call of calls) {
      const result = await executeCall(call);
      push({ type: "function_call_output", callId: call.callId, output: wrapToolOutput(result) });
    }
  }
  return finish("model_limit");

  async function executeCall(call: Extract<ConversationItem, { type: "function_call" }>): Promise<ToolResult | { status: "blocked"; message: string }> {
    const started = performance.now();
    const record = (r: Omit<ToolCallRecord, "callId" | "name" | "durationMs">) => {
      toolCalls.push({ callId: call.callId, name: call.name, durationMs: Math.round(performance.now() - started), ...r });
    };
    const block = (message: string, args: ToolCallRecord["arguments"] = call.arguments) => {
      tracer?.event("agent.tool_blocked", { name: call.name, outcome: "denied", attributes: { reason: message } });
      record({ arguments: args, executed: false, status: "blocked", message });
      return { status: "blocked" as const, message };
    };

    if (toolCalls.filter((c) => c.executed).length >= limits.maxToolCalls) {
      toolBudgetExhausted = true;
      return block(`Tool call limit (${limits.maxToolCalls}) reached for this request. No further tools will run.`);
    }
    if (!isKnownTool(call.name)) return block(`Unknown tool "${call.name}".`);

    const checked = preflight(call.name, call.arguments, input.idempotencySeed);
    if (!checked.ok) return block(`Invalid arguments: ${checked.message}`);

    tracer?.event("agent.tool_selected", {
      name: call.name,
      attributes: { arguments: checked.args, mutating: isMutating(call.name) },
    });

    if (Date.now() >= deadline) return block("The request ran out of time before this tool could run.", checked.args);
    try {
      // Single attempt: mutating tools are never retried, read-only tools are cheap to re-ask.
      const result = await callMcpTool(input.mcp, call.name, checked.args, Math.min(limits.toolTimeoutMs, deadline - Date.now()));
      record({
        arguments: checked.args,
        executed: true,
        status: result.status,
        message: result.message,
        authorization: result.authorization,
        approvalId: result.approvalId,
      });
      return result;
    } catch (error) {
      const message = isMutating(call.name)
        ? "The tool call failed before a result was received. It was not retried; check its status before trying again."
        : "The tool call failed. Please try again.";
      tracer?.event("agent.tool_failed", { name: call.name, outcome: "error", attributes: { error: errorName(error) } });
      record({ arguments: checked.args, executed: true, status: "error", message });
      return { status: "error", message, correlationId: "" };
    }
  }

  function finish(stopReason: StopReason): TurnResult {
    const lastMessage = [...newItems].reverse().find((i) => i.type === "message" && i.role === "assistant");
    let reply =
      lastMessage?.type === "message" && stopReason === "completed"
        ? lastMessage.content
        : fallbackReply(stopReason, toolCalls);
    const guardNotes = verifyReply(reply, toolCalls);
    if (guardNotes.length > 0) {
      reply = `${reply}\n\n> **Gatekeeper note:** ${guardNotes.join(" ")}`;
      tracer?.event("agent.reply_corrected", { outcome: "denied", attributes: { notes: guardNotes } });
    }
    if (lastMessage?.type === "message" && stopReason === "completed") lastMessage.content = reply;
    else push({ type: "message", role: "assistant", content: reply });
    return { reply, newItems, toolCalls, stopReason, guardNotes };
  }
}

const STOP_MESSAGES: Record<Exclude<StopReason, "completed">, string> = {
  tool_limit: "I stopped because this request reached the maximum number of tool calls.",
  model_limit: "I stopped because this request needed too many reasoning steps.",
  timeout: "I stopped because the request took too long.",
  model_error: "The AI model could not be reached, so I could not finish this request.",
};

/** A factual summary built only from real tool records — used when the model cannot finish. */
function fallbackReply(reason: StopReason, calls: ToolCallRecord[]): string {
  const header = reason === "completed" ? "Done." : STOP_MESSAGES[reason];
  if (calls.length === 0) return header;
  const lines = calls.map((c) => `- \`${c.name}\` → ${c.status}: ${c.message}`);
  return `${header} Here is what actually happened:\n${lines.join("\n")}`;
}

const REFUND_SUCCESS_CLAIM = new RegExp(
  [
    String.raw`\brefund(?:s|ed)?\b[^.]{0,40}\b(?:has|have|was|were|is|are)(?:\s+now)?(?:\s+been)?\s+(?:successfully\s+)?(?:issued|processed|completed|executed|sent|approved|paid)`,
    String.raw`\bi(?:'ve| have)\s+(?:successfully\s+)?(?:issued|processed|completed|approved|executed)\s+(?:the|a|your|all)?\s*refunds?`,
    String.raw`\b(?:successfully|have)\s+refunded\b`,
  ].join("|"),
  "i",
);

/**
 * Deterministic guard against the most damaging hallucination in this domain:
 * claiming a refund happened when the backend only created (or denied) a request.
 */
export function verifyReply(reply: string, calls: ToolCallRecord[]): string[] {
  const notes: string[] = [];
  const approvedSeen = calls.some((c) => c.name === "get_approval_status" && c.status === "ok" && /\bapproved\b/i.test(c.message));
  if (REFUND_SUCCESS_CLAIM.test(reply) && !approvedSeen) {
    const pending = calls.filter((c) => c.status === "pending_approval");
    notes.push(
      pending.length > 0
        ? `No refund has been executed. ${pending.map((c) => `Approval ${c.approvalId} is pending manager approval.`).join(" ")}`
        : "No refund was executed during this request.",
    );
  }
  return notes;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
