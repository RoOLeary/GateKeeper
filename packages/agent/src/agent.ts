import { performance } from "node:perf_hooks";
import { and, asc, desc, eq } from "drizzle-orm";
import { loadActor } from "@gatekeeper/core";
import { agentMessages, type Database } from "@gatekeeper/database";
import { connectInProcess } from "@gatekeeper/mcp-server";
import { newCorrelationId, Tracer } from "@gatekeeper/observability";
import type { ConversationItem, ModelClient } from "./model";
import { OfflineModel } from "./offline-model";
import { createOpenAIModelFromEnv } from "./openai-model";
import { runTurn, type AgentLimits, type StopReason, type ToolCallRecord } from "./orchestration";
import { buildInstructions } from "./prompt";
import { discoverTools } from "./tools";

/** Context-window guard: how many persisted model items are replayed into each turn. */
const HISTORY_ITEMS = 40;
const MAX_MESSAGE_LENGTH = 2_000;

export interface AgentSession {
  /** Server-side session ID. The principal is resolved from it by trusted code before calling the agent. */
  sessionId: string;
  userId: string;
}

export interface AssistantDisplayMessage {
  role: "assistant";
  content: string;
  toolCalls: ToolCallRecord[];
  durationMs: number;
  correlationId: string;
  model: { id: string; kind: ModelClient["kind"] };
  stopReason: StopReason;
  at: string;
}

export interface UserDisplayMessage {
  role: "user";
  content: string;
  correlationId: string;
  at: string;
}

export type DisplayMessage = UserDisplayMessage | AssistantDisplayMessage;

export function createModelFromEnv(): ModelClient {
  return createOpenAIModelFromEnv() ?? new OfflineModel();
}

function loadModelHistory(db: Database, sessionId: string): ConversationItem[] {
  const items = db
    .select({ payload: agentMessages.payload })
    .from(agentMessages)
    .where(and(eq(agentMessages.sessionId, sessionId), eq(agentMessages.kind, "model_item")))
    .orderBy(desc(agentMessages.id))
    .limit(HISTORY_ITEMS)
    .all()
    .reverse()
    .map((r) => JSON.parse(r.payload) as ConversationItem);
  // Never start the window mid tool-exchange: drop leading items until a user message.
  const firstUser = items.findIndex((i) => i.type === "message" && i.role === "user");
  return firstUser === -1 ? [] : items.slice(firstUser);
}

export function loadDisplayHistory(db: Database, sessionId: string): DisplayMessage[] {
  return db
    .select({ payload: agentMessages.payload, kind: agentMessages.kind })
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, sessionId))
    .orderBy(asc(agentMessages.id))
    .all()
    .filter((r) => r.kind === "display")
    .map((r) => (JSON.parse(r.payload) as { message: DisplayMessage }).message);
}

function persist(db: Database, sessionId: string, items: ConversationItem[], display: DisplayMessage[]) {
  db.transaction((tx) => {
    for (const message of display.filter((m) => m.role === "user")) {
      tx.insert(agentMessages).values({ sessionId, kind: "display", payload: JSON.stringify({ message }) }).run();
    }
    for (const item of items) {
      if (item.type === "provider_state") continue;
      tx.insert(agentMessages).values({ sessionId, kind: "model_item", payload: JSON.stringify(item) }).run();
    }
    for (const message of display.filter((m) => m.role === "assistant")) {
      tx.insert(agentMessages).values({ sessionId, kind: "display", payload: JSON.stringify({ message }) }).run();
    }
  });
}

export function clearConversation(db: Database, sessionId: string): void {
  db.delete(agentMessages).where(eq(agentMessages.sessionId, sessionId)).run();
}

export interface RunAgentOptions {
  db: Database;
  session: AgentSession;
  message: string;
  model?: ModelClient;
  limits?: Partial<AgentLimits>;
}

/**
 * Runs one conversational turn for a trusted session:
 *   1. binds a fresh MCP server to the session's principal (in-process transport),
 *   2. discovers tools over MCP, 3. runs the bounded tool-calling loop,
 *   4. persists conversation state and emits execution traces.
 */
export async function runAgent({ db, session, message, model = createModelFromEnv(), limits }: RunAgentOptions) {
  const correlationId = newCorrelationId();
  const tracer = new Tracer(db, { correlationId, sessionId: session.sessionId, actorId: session.userId });
  const started = performance.now();
  const text = message.trim().slice(0, MAX_MESSAGE_LENGTH);
  const at = new Date().toISOString();

  tracer.event("request.received", { attributes: { length: text.length, preview: maskPreview(text) } });

  const actor = loadActor(db, session.userId);
  const { client, close } = await connectInProcess({
    db,
    principal: { userId: session.userId, sessionId: session.sessionId },
    channel: "mcp",
    correlationId,
  });

  try {
    const tools = await discoverTools(client);
    tracer.event("agent.tools_discovered", { attributes: { count: tools.length, tools: tools.map((t) => t.name) } });

    const turn = await runTurn({
      model,
      mcp: client,
      tools,
      instructions: buildInstructions(actor),
      history: loadModelHistory(db, session.sessionId),
      userMessage: text,
      limits,
      tracer,
      idempotencySeed: `${session.sessionId}:${correlationId}`,
    });

    const durationMs = Math.round(performance.now() - started);
    const assistant: AssistantDisplayMessage = {
      role: "assistant",
      content: turn.reply,
      toolCalls: turn.toolCalls,
      durationMs,
      correlationId,
      model: { id: model.id, kind: model.kind },
      stopReason: turn.stopReason,
      at: new Date().toISOString(),
    };
    persist(db, session.sessionId, turn.newItems, [{ role: "user", content: text, correlationId, at }, assistant]);
    tracer.event("agent.response_generated", {
      outcome: turn.stopReason === "completed" ? "ok" : "error",
      durationMs,
      attributes: { stopReason: turn.stopReason, toolCalls: turn.toolCalls.length, model: model.id },
    });
    return assistant;
  } finally {
    await close();
  }
}

/** Short, PII-masked preview of the user request for the trace viewer. */
function maskPreview(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+?\d[\d ()-]{7,}\d/g, "[phone]")
    .slice(0, 120);
}
