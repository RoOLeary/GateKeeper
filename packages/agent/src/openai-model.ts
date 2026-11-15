import OpenAI from "openai";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses.js";
import type { ConversationItem, ModelClient, ModelRequest, ModelResponse } from "./model";

/**
 * OpenAI Responses API adapter. Runs with `store: false` so customer data is not
 * retained provider-side; conversation state lives in Gatekeeper's own database.
 */
export class OpenAIModel implements ModelClient {
  readonly kind = "llm" as const;
  readonly id: string;
  private readonly reasoning: boolean;

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {
    this.id = `openai:${model}`;
    this.reasoning = /^(gpt-5|o\d)/.test(model);
  }

  async generate({ instructions, items, tools, signal }: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.responses.create(
      {
        model: this.model,
        instructions,
        input: items.flatMap(toOpenAI),
        tools: tools.map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: false,
        })),
        parallel_tool_calls: false,
        store: false,
        ...(this.reasoning ? { include: ["reasoning.encrypted_content" as const] } : {}),
      },
      { signal, maxRetries: 1 },
    );
    return { items: response.output.flatMap(fromOpenAI) };
  }
}

function toOpenAI(item: ConversationItem): ResponseInputItem[] {
  switch (item.type) {
    case "message":
      return [{ role: item.role, content: item.content }];
    case "function_call":
      return [{ type: "function_call", call_id: item.callId, name: item.name, arguments: item.arguments }];
    case "function_call_output":
      return [{ type: "function_call_output", call_id: item.callId, output: item.output }];
    case "provider_state":
      return [item.data as ResponseInputItem];
  }
}

function fromOpenAI(item: ResponseOutputItem): ConversationItem[] {
  if (item.type === "message") {
    const text = item.content
      .map((part) => (part.type === "output_text" ? part.text : ""))
      .join("")
      .trim();
    return text ? [{ type: "message", role: "assistant", content: text }] : [];
  }
  if (item.type === "function_call") {
    return [{ type: "function_call", callId: item.call_id, name: item.name, arguments: item.arguments }];
  }
  if (item.type === "reasoning") return [{ type: "provider_state", data: item }];
  return [];
}

export function createOpenAIModelFromEnv(): OpenAIModel | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenAIModel(new OpenAI({ apiKey, timeout: 45_000 }), process.env.OPENAI_MODEL?.trim() || "gpt-5-mini");
}
