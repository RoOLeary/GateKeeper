import Link from "next/link";
import { listAuditForViewer, listDemoUsers, listTraces } from "@gatekeeper/core";
import { getDatabase, type TraceEvent, type TraceOutcome } from "@gatekeeper/database";
import { Badge, StatusBadge } from "@/components/badges";
import { Card, PageHeader, SignedOut } from "@/components/page";
import { webContext } from "@/lib/context";
import { clock, duration } from "@/lib/format";
import { getSession } from "@/lib/session";
import { traceDetail, traceLabel } from "@/lib/trace-labels";

const OUTCOMES: TraceOutcome[] = ["ok", "denied", "pending", "error"];
const DECISION_FOR_OUTCOME: Record<string, string> = { ok: "allow", denied: "deny", pending: "requires_approval", error: "error" };
const VISIBILITY = {
  all: "You can see all traces and audit events.",
  team: "You can see traces and audit events for your team.",
  own: "Support agents only see their own traces and audit events.",
} as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function TracesPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  if (!session) return <SignedOut />;
  const params = await searchParams;
  const one = (k: string) => (typeof params[k] === "string" ? (params[k] as string).trim() : "");
  const correlationId = one("correlationId");
  const actorId = one("actor");
  const outcome = OUTCOMES.includes(one("outcome") as TraceOutcome) ? (one("outcome") as TraceOutcome) : undefined;

  const ctx = webContext(session);
  const traces = listTraces(ctx, { correlationId, actorId: actorId || undefined, limit: 600 });
  const audit = listAuditForViewer(ctx, {
    correlationId,
    actorId: actorId || undefined,
    decision: outcome ? DECISION_FOR_OUTCOME[outcome] : undefined,
  });
  const users = listDemoUsers(getDatabase());

  const groups = groupByCorrelation(traces.events)
    .filter((g) => !outcome || groupOutcome(g.events) === outcome)
    .slice(0, 25);

  return (
    <>
      <PageHeader
        title="Audit & Execution Traces"
        description={`Diagnostic traces show how each request moved through agent → MCP → policy → services. Security audit events are stored separately. ${VISIBILITY[traces.visibility]}`}
      />
      <div className="space-y-6 px-8 py-6">
        <form className="flex flex-wrap items-end gap-3 text-xs">
          <label className="space-y-1">
            <span className="block text-zinc-500">Request ID</span>
            <input
              name="correlationId"
              defaultValue={correlationId}
              placeholder="req_…"
              className="w-60 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-zinc-100 outline-none focus:border-emerald-500"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-zinc-500">Actor</span>
            <select name="actor" defaultValue={actorId} className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-zinc-100">
              <option value="">Any</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.id})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-zinc-500">Outcome</span>
            <select name="outcome" defaultValue={outcome ?? ""} className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-zinc-100">
              <option value="">Any</option>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <button className="rounded-md bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700">Filter</button>
          {(correlationId || actorId || outcome) && (
            <Link href="/traces" className="px-2 py-1.5 text-zinc-500 hover:text-zinc-300">
              Clear
            </Link>
          )}
        </form>

        <section className="space-y-4">
          <h2 className="text-sm font-medium text-zinc-300">Execution traces</h2>
          {groups.length === 0 && <p className="text-sm text-zinc-500">No traces match. Run something in the Agent Console first.</p>}
          {groups.map((g) => (
            <TraceGroup key={g.correlationId} correlationId={g.correlationId} events={g.events} />
          ))}
        </section>

        <Card>
          <h2 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-white">Security audit events</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs [&_td]:pr-4 [&_th]:pr-4">
              <thead className="text-zinc-500">
                <tr className="border-b border-zinc-800">
                  <th className="px-4 py-2 font-medium">Time (UTC)</th>
                  <th className="font-medium">Actor</th>
                  <th className="font-medium">Action</th>
                  <th className="font-medium">Resource</th>
                  <th className="font-medium">Decision</th>
                  <th className="font-medium">Reason</th>
                  <th className="font-medium">Channel</th>
                  <th className="font-medium">Request</th>
                </tr>
              </thead>
              <tbody>
                {audit.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-3 text-zinc-500">
                      No audit events match.
                    </td>
                  </tr>
                )}
                {audit.map((e) => (
                  <tr key={e.id} className="border-b border-zinc-800/60 last:border-0">
                    <td className="whitespace-nowrap px-4 py-1.5 font-mono text-zinc-500">
                      {e.timestamp.slice(0, 10)} {clock(e.timestamp)}
                    </td>
                    <td className="font-mono text-zinc-300">{e.actorId ?? "anonymous"}</td>
                    <td className="font-mono text-zinc-300">{e.action}</td>
                    <td className="font-mono text-zinc-400">{e.resourceType ? `${e.resourceType}${e.resourceId ? `:${e.resourceId}` : ""}` : "—"}</td>
                    <td>
                      <StatusBadge status={e.decision} />
                    </td>
                    <td className="max-w-md text-zinc-400">{e.reason}</td>
                    <td className="text-zinc-500">{e.channel}</td>
                    <td>
                      <Link href={`/traces?correlationId=${e.correlationId}`} className="font-mono text-zinc-500 hover:text-emerald-300">
                        {e.correlationId}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}

function groupByCorrelation(events: TraceEvent[]) {
  const map = new Map<string, TraceEvent[]>();
  for (const e of events) {
    const list = map.get(e.correlationId) ?? [];
    list.push(e);
    map.set(e.correlationId, list);
  }
  // Events arrive newest-first; each timeline is shown oldest-first.
  return [...map.entries()].map(([correlationId, list]) => ({ correlationId, events: list.reverse() }));
}

function groupOutcome(events: TraceEvent[]): TraceOutcome {
  if (events.some((e) => e.outcome === "error")) return "error";
  if (events.some((e) => e.outcome === "denied")) return "denied";
  if (events.some((e) => e.outcome === "pending")) return "pending";
  return "ok";
}

function TraceGroup({ correlationId, events }: { correlationId: string; events: TraceEvent[] }) {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const span = new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
  const outcome = groupOutcome(events);
  const isAgent = events.some((e) => e.type.startsWith("agent."));

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-xs">
        <Link href={`/traces?correlationId=${correlationId}`} className="font-mono text-zinc-200 hover:text-emerald-300">
          {correlationId}
        </Link>
        <Badge tone={isAgent ? "sky" : "zinc"}>{isAgent ? "agent run" : events.some((e) => e.type === "request.received") ? "web action" : "mcp client"}</Badge>
        <StatusBadge status={outcome} />
        <span className="font-mono text-zinc-500">{first.actorId ?? "anonymous"}</span>
        <span className="ml-auto text-zinc-500">
          {first.timestamp.slice(0, 10)} · {events.length} events · {duration(span)}
        </span>
      </div>
      <ol className="divide-y divide-zinc-800/60">
        {events.map((e) => {
          const attrs = e.attributes ? (JSON.parse(e.attributes) as Record<string, any>) : {};
          const detail = traceDetail(e, attrs);
          return (
            <li key={e.id} className="grid grid-cols-[110px_14px_1fr_auto] items-start gap-3 px-4 py-1.5 text-xs">
              <span className="font-mono text-zinc-500">{clock(e.timestamp)}</span>
              <span
                className={`mt-1 h-2 w-2 rounded-full ${
                  e.outcome === "ok" ? "bg-emerald-400" : e.outcome === "denied" ? "bg-rose-400" : e.outcome === "pending" ? "bg-amber-400" : e.outcome === "error" ? "bg-rose-600" : "bg-zinc-600"
                }`}
              />
              <div className="min-w-0">
                <span className="text-zinc-200">{traceLabel(e, attrs)}</span>
                {detail && <span className="ml-2 break-all text-zinc-500">{detail}</span>}
                {e.type === "authz.evaluated" && Array.isArray(attrs.checks) && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">policy checks</summary>
                    <ul className="mt-1 space-y-0.5">
                      {attrs.checks.map((c: { name: string; passed: boolean; detail: string }, i: number) => (
                        <li key={i} className="flex gap-2">
                          <span className={c.passed ? "text-emerald-400" : "text-rose-400"}>{c.passed ? "✓" : "✗"}</span>
                          <span className="w-28 font-mono text-zinc-500">{c.name}</span>
                          <span className="text-zinc-400">{c.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              <span className="text-zinc-500">{duration(e.durationMs)}</span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
