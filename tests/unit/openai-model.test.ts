import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { OpenAIModel } from "@gatekeeper/agent";

function fakeClient(output: unknown[]) {
  const calls: { body: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  const client = {
    responses: {
      create: async (body: Record<string, unknown>, options: Record<string, unknown>) => {
        calls.push({ body, options });
        return { output };
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

describe("OpenAIModel adapter (no network)", () => {
  it("sends a stateless, sequential tool-calling request and maps the response", async () => {
    const { client, calls } = fakeClient([
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
      { type: "function_call", call_id: "call_1", name: "get_customer", arguments: '{"customerId":1024}' },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: " Done. " }] },
    ]);
    const model = new OpenAIModel(client, "gpt-5-mini");
    const signal = new AbortController().signal;

    const response = await model.generate({
      instructions: "rules",
      items: [
        { type: "message", role: "user", content: "Show customer 1024" },
        { type: "function_call", callId: "call_0", name: "get_order_status", arguments: '{"orderId":5021}' },
        { type: "function_call_output", callId: "call_0", output: '{"status":"ok"}' },
      ],
      tools: [{ name: "get_customer", description: "Get a customer", parameters: { type: "object" } }],
      signal,
    });

    const [{ body, options }] = calls as [(typeof calls)[number]];
    expect(body).toMatchObject({
      model: "gpt-5-mini",
      instructions: "rules",
      store: false,
      parallel_tool_calls: false,
      include: ["reasoning.encrypted_content"],
    });
    expect(body.input).toEqual([
      { role: "user", content: "Show customer 1024" },
      { type: "function_call", call_id: "call_0", name: "get_order_status", arguments: '{"orderId":5021}' },
      { type: "function_call_output", call_id: "call_0", output: '{"status":"ok"}' },
    ]);
    expect(options.signal).toBe(signal);

    expect(response.items).toEqual([
      { type: "provider_state", data: expect.objectContaining({ type: "reasoning" }) },
      { type: "function_call", callId: "call_1", name: "get_customer", arguments: '{"customerId":1024}' },
      { type: "message", role: "assistant", content: "Done." },
    ]);
  });

  it("does not request reasoning content for non-reasoning models", async () => {
    const { client, calls } = fakeClient([]);
    await new OpenAIModel(client, "gpt-4.1-mini").generate({
      instructions: "",
      items: [],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(calls[0]?.body.include).toBeUndefined();
  });
});
