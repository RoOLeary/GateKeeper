/**
 * Provider-neutral conversation model. The orchestration loop only speaks this
 * vocabulary, which keeps it testable with scripted models and swappable providers.
 */
export type ConversationItem =
  | { type: "message"; role: "user" | "assistant"; content: string }
  | { type: "function_call"; callId: string; name: string; arguments: string }
  | { type: "function_call_output"; callId: string; output: string }
  /** Opaque provider state (e.g. reasoning items). Kept within a turn, never persisted. */
  | { type: "provider_state"; data: unknown };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  instructions: string;
  items: ConversationItem[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export interface ModelResponse {
  items: ConversationItem[];
}

export interface ModelClient {
  /** Human-readable identifier shown in the UI and traces. */
  readonly id: string;
  readonly kind: "llm" | "offline" | "scripted";
  generate(request: ModelRequest): Promise<ModelResponse>;
}
