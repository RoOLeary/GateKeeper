import { createSeededDatabase, sessions, type Database } from "@gatekeeper/database";
import type { ConversationItem, ModelClient, ModelRequest } from "@gatekeeper/agent";

/** A model driven by a test script — used to simulate a compromised or misbehaving LLM. */
export class ScriptedModel implements ModelClient {
  readonly id = "scripted";
  readonly kind = "scripted" as const;
  calls = 0;
  constructor(private readonly script: (req: ModelRequest, call: number) => ConversationItem[] | Promise<ConversationItem[]>) {}
  async generate(req: ModelRequest) {
    return { items: await this.script(req, this.calls++) };
  }
}

export const fnCall = (name: string, args: Record<string, unknown>, id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`): ConversationItem => ({
  type: "function_call",
  callId: id,
  name,
  arguments: JSON.stringify(args),
});

export const say = (content: string): ConversationItem => ({ type: "message", role: "assistant", content });

/** Returns true once the last item in the request is a tool output (i.e. the model should answer). */
export const hasToolOutputs = (req: ModelRequest) => req.items.at(-1)?.type === "function_call_output";

export function createAgentEnv(userId: string): { db: Database; session: { sessionId: string; userId: string } } {
  const db = createSeededDatabase();
  const sessionId = `sess_${userId}`;
  const now = new Date().toISOString();
  db.insert(sessions).values({ id: sessionId, tokenHash: `hash_${userId}`, userId, createdAt: now, expiresAt: now }).run();
  return { db, session: { sessionId, userId } };
}
