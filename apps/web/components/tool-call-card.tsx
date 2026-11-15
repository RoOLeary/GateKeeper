import Link from "next/link";
import type { ToolCallRecord } from "@gatekeeper/agent";
import { duration } from "@/lib/format";
import { Badge, StatusBadge } from "./badges";

const EFFECT_TONE = { allow: "green", deny: "red", requires_approval: "amber" } as const;

export function ToolCallCard({ call }: { call: ToolCallRecord }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-emerald-300">{call.name}</span>
        <StatusBadge status={call.status} />
        {call.authorization ? (
          <Badge tone={EFFECT_TONE[call.authorization.effect]}>
            policy: {call.authorization.effect.replace("_", " ")} · {call.authorization.code}
          </Badge>
        ) : (
          !call.executed && <Badge tone="red">blocked before MCP</Badge>
        )}
        {call.approvalId && (
          <Link href="/approvals" className="font-mono text-[11px] text-amber-300 underline-offset-2 hover:underline">
            {call.approvalId}
          </Link>
        )}
        <span className="ml-auto text-zinc-500">{duration(call.durationMs)}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-400">{call.authorization?.effect === "deny" ? call.authorization.reason : call.message}</p>
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">arguments</summary>
        <pre className="mt-1 overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-[11px] text-zinc-300">
          {typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments, null, 2)}
        </pre>
      </details>
    </div>
  );
}
