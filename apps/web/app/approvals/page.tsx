import Link from "next/link";
import { listApprovals } from "@gatekeeper/core";
import { ApprovalActions } from "@/components/approval-actions";
import { Badge, StatusBadge } from "@/components/badges";
import { Card, PageHeader, SignedOut } from "@/components/page";
import { webContext } from "@/lib/context";
import { dateTime, money } from "@/lib/format";
import { getSession } from "@/lib/session";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  if (!session) return <SignedOut />;
  const approvals = listApprovals(webContext(session));
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");
  const isSupport = session.actor.role === "support_agent";
  const { decided: decidedId } = await searchParams;
  const justDecided = typeof decidedId === "string" ? approvals.find((a) => a.id === decidedId) : undefined;

  return (
    <>
      <PageHeader
        title="Approval Queue"
        description={
          isSupport
            ? "Support agents can request refunds but cannot approve them. You can track the requests visible to you here."
            : "Refunds require a second, authorized person. Approving re-validates the request, re-checks your authority and the order's current state, then executes the refund exactly once."
        }
      />
      <div className="space-y-8 px-8 py-6">
        {justDecided && justDecided.status !== "pending" && (
          <div
            className={`rounded-lg px-4 py-3 text-sm ring-1 ${
              justDecided.status === "approved" ? "bg-emerald-500/10 text-emerald-200 ring-emerald-500/30" : "bg-rose-500/10 text-rose-200 ring-rose-500/30"
            }`}
          >
            <span className="font-mono">{justDecided.id}</span> was <strong>{justDecided.status}</strong>
            {justDecided.status === "approved" && justDecided.refundId
              ? ` — refund ${justDecided.refundId} of ${money(justDecided.amount, justDecided.currency)} executed exactly once for order ${justDecided.orderId}.`
              : justDecided.decisionReason
                ? ` — ${justDecided.decisionReason}`
                : "."}
          </div>
        )}
        <section>
          <h2 className="mb-3 text-sm font-medium text-zinc-300">Pending ({pending.length})</h2>
          {pending.length === 0 && <p className="text-sm text-zinc-500">Nothing is waiting for a decision.</p>}
          <div className="grid gap-4 xl:grid-cols-2">
            {pending.map((a) => (
              <Card key={a.id} className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-mono text-xs text-zinc-500">{a.id}</p>
                    <p className="mt-1 text-lg font-semibold text-white">{money(a.amount, a.currency)} refund</p>
                    <p className="text-xs text-zinc-400">
                      Order <span className="font-mono text-zinc-200">{a.orderId}</span> · {a.customerName} (#{a.customerId})
                    </p>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-zinc-500">Operation</dt>
                  <dd className="font-mono text-zinc-300">{a.operation}</dd>
                  <dt className="text-zinc-500">Requested by</dt>
                  <dd className="text-zinc-300">
                    {a.requester.name} <span className="font-mono text-zinc-500">({a.requester.id})</span>
                  </dd>
                  <dt className="text-zinc-500">Reason</dt>
                  <dd className="text-zinc-300">{a.reason}</dd>
                  <dt className="text-zinc-500">Requested</dt>
                  <dd className="text-zinc-400">{dateTime(a.createdAt)}</dd>
                  {a.correlationId && a.correlationId !== "seed" && (
                    <>
                      <dt className="text-zinc-500">Trace</dt>
                      <dd>
                        <Link href={`/traces?correlationId=${a.correlationId}`} className="font-mono text-zinc-400 hover:text-emerald-300">
                          {a.correlationId}
                        </Link>
                      </dd>
                    </>
                  )}
                </dl>

                {a.preview && (
                  <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs">
                      <span className="font-medium text-zinc-300">Authorization preview for you</span>
                      <Badge tone={a.preview.canApprove ? "green" : "red"}>{a.preview.canApprove ? "can approve" : "cannot approve"}</Badge>
                    </div>
                    <ul className="space-y-1 text-xs">
                      {a.preview.checks.map((c, i) => (
                        <li key={i} className="flex gap-2">
                          <span className={c.passed ? "text-emerald-400" : "text-rose-400"}>{c.passed ? "✓" : "✗"}</span>
                          <span className="w-28 shrink-0 font-mono text-zinc-500">{c.name}</span>
                          <span className="text-zinc-400">{c.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {!isSupport && a.preview && (
                  <div className="mt-4">
                    <ApprovalActions
                      approvalId={a.id}
                      canApprove={a.preview.canApprove}
                      reason={a.preview.reason}
                    />
                  </div>
                )}
              </Card>
            ))}
          </div>
        </section>

        <Card>
          <h2 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-white">Decided</h2>
          <div className="overflow-x-auto">
          <table className="w-full text-left text-xs [&_td]:pr-4 [&_th]:pr-4">
            <thead className="text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="px-4 py-2 font-medium">Approval</th>
                <th className="font-medium">Order</th>
                <th className="font-medium">Amount</th>
                <th className="font-medium">Status</th>
                <th className="font-medium">Requester</th>
                <th className="font-medium">Decided by</th>
                <th className="font-medium">Note</th>
                <th className="font-medium">Refund</th>
                <th className="font-medium">Decided</th>
              </tr>
            </thead>
            <tbody>
              {decided.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-3 text-zinc-500">
                    No decisions yet.
                  </td>
                </tr>
              )}
              {decided.map((a) => (
                <tr key={a.id} className="border-b border-zinc-800/60 last:border-0">
                  <td className="px-4 py-2 font-mono text-zinc-300">{a.id}</td>
                  <td className="font-mono">{a.orderId}</td>
                  <td>{money(a.amount, a.currency)}</td>
                  <td>
                    <StatusBadge status={a.status} />
                  </td>
                  <td className="text-zinc-400">{a.requester.name}</td>
                  <td className="text-zinc-400">{a.approver?.name ?? "—"}</td>
                  <td className="max-w-xs text-zinc-500">{a.decisionReason}</td>
                  <td className="font-mono text-zinc-500">{a.refundId ?? "—"}</td>
                  <td className="text-zinc-500">{dateTime(a.decidedAt)}</td>
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
