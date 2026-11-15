"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AssistantDisplayMessage, DisplayMessage } from "@gatekeeper/agent";
import { duration } from "@/lib/format";
import { Badge } from "./badges";
import { Markdown } from "./markdown";
import { ToolCallCard } from "./tool-call-card";

interface Props {
  initialMessages: DisplayMessage[];
  suggestions: string[];
}

export function ChatConsole({ initialMessages, suggestions }: Props) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: message, correlationId: "", at: new Date().toISOString() }]);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const body = (await res.json()) as { message?: AssistantDisplayMessage; error?: string };
      if (!res.ok || !body.message) throw new Error(body.error ?? "Request failed");
      setMessages((m) => [...m, body.message!]);
      router.refresh(); // update approval badge etc.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    await fetch("/api/agent", { method: "DELETE" });
    setMessages([]);
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <div className="flex h-[calc(100vh-97px)] flex-col">
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {messages.length === 0 && (
          <div className="mx-auto max-w-2xl py-10 text-center">
            <p className="text-sm text-zinc-400">
              Ask the assistant to work with customers, orders and refunds. Every tool call travels through MCP and is authorized by the
              backend — try something you are <em>not</em> allowed to do.
            </p>
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-600/20 px-4 py-2 text-sm text-emerald-50 ring-1 ring-emerald-500/20">
                  {m.content}
                </div>
              </div>
            ) : (
              <AssistantMessage key={i} message={m} />
            ),
          )}
          {busy && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              Agent is working — selecting tools, calling MCP, awaiting authorization…
            </div>
          )}
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-zinc-800 bg-zinc-950/80 px-8 py-4">
        <div className="mx-auto max-w-3xl">
          <div className="mb-3 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => void send(s)}
                className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400 transition hover:border-emerald-500/50 hover:text-emerald-200 disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
          <form onSubmit={onSubmit} className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='e.g. "Refund €120 for order 5021"'
              maxLength={2000}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-500"
            />
            <button
              disabled={busy || !input.trim()}
              className="rounded-lg bg-emerald-500 px-4 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
            >
              Send
            </button>
            {messages.length > 0 && (
              <button type="button" onClick={() => void clear()} className="rounded-lg px-3 text-xs text-zinc-500 hover:text-zinc-300">
                Clear
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

function AssistantMessage({ message }: { message: AssistantDisplayMessage }) {
  return (
    <div className="rounded-2xl rounded-bl-sm border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      {message.toolCalls.length > 0 && (
        <div className="mb-3 space-y-2">
          {message.toolCalls.map((call) => (
            <ToolCallCard key={call.callId} call={call} />
          ))}
        </div>
      )}
      <Markdown text={message.content} />
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[11px] text-zinc-500">
        <Badge tone={message.model.kind === "llm" ? "sky" : "amber"}>{message.model.id}</Badge>
        <span>{message.toolCalls.length} tool call(s)</span>
        <span>· {duration(message.durationMs)}</span>
        {message.stopReason !== "completed" && <Badge tone="red">stopped: {message.stopReason.replace("_", " ")}</Badge>}
        <Link href={`/traces?correlationId=${message.correlationId}`} className="ml-auto font-mono text-zinc-400 hover:text-emerald-300">
          {message.correlationId} → trace
        </Link>
      </div>
    </div>
  );
}
