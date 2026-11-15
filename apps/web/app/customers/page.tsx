import { getOperationsOverview } from "@gatekeeper/core";
import { StatusBadge } from "@/components/badges";
import { Card, PageHeader, SignedOut } from "@/components/page";
import { webContext } from "@/lib/context";
import { dateTime, money, shortDate } from "@/lib/format";
import { getSession } from "@/lib/session";

const SCOPE_NOTE = {
  support_agent: "Showing customers assigned to you.",
  manager: "Showing customers handled by your team.",
  admin: "Showing all customers (administrator).",
} as const;

export default async function CustomersPage() {
  const session = await getSession();
  if (!session) return <SignedOut />;
  const { customers, refunds } = getOperationsOverview(webContext(session));

  return (
    <>
      <PageHeader
        title="Customer Operations"
        description={`${SCOPE_NOTE[session.actor.role]} The same policy layer that guards the agent's tools filters this view.`}
      />
      <div className="space-y-6 px-8 py-6">
        {customers.length === 0 && <p className="text-sm text-zinc-500">No customers are visible to you.</p>}
        <div className="grid gap-4 xl:grid-cols-2">
          {customers.map((c) => (
            <Card key={c.id} className="min-w-0 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-zinc-500">#{c.id}</span>
                    <h2 className="font-medium text-white">{c.name}</h2>
                    <StatusBadge status={c.accountStatus} />
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    {c.email}
                    {c.phone ? ` · ${c.phone}` : ""}
                  </p>
                </div>
                <p className="text-right text-xs text-zinc-500">
                  Rep
                  <br />
                  <span className="text-zinc-300">{c.assignedRep.name}</span>
                </p>
              </div>
              <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-xs whitespace-nowrap [&_td]:pr-3 [&_th]:pr-3">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-1.5 font-medium">Order</th>
                    <th className="font-medium max-xl:hidden">Created</th>
                    <th className="font-medium">Status</th>
                    <th className="text-right font-medium">Amount</th>
                    <th className="text-right font-medium">Refunded</th>
                    <th className="text-right font-medium">Refundable</th>
                  </tr>
                </thead>
                <tbody>
                  {c.orders.map((o) => (
                    <tr key={o.id} className="border-b border-zinc-800/60 last:border-0">
                      <td className="py-1.5 font-mono text-zinc-300">{o.id}</td>
                      <td className="text-zinc-500 max-xl:hidden">{shortDate(o.createdAt)}</td>
                      <td>
                        <StatusBadge status={o.status} />
                      </td>
                      <td className="text-right text-zinc-200">{money(o.amount, o.currency)}</td>
                      <td className="text-right text-zinc-400">{o.refundedAmount ? money(o.refundedAmount, o.currency) : "—"}</td>
                      <td className="text-right text-zinc-400">
                        {money(o.refundableAmount, o.currency)}
                        {o.pendingRefundAmount > 0 && (
                          <span className="block text-[10px] text-amber-300">{money(o.pendingRefundAmount, o.currency)} pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Card>
          ))}
        </div>

        <Card>
          <h2 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-white">Executed refunds</h2>
          <div className="overflow-x-auto">
          <table className="w-full text-left text-xs [&_td]:pr-4 [&_th]:pr-4">
            <thead className="text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="px-4 py-2 font-medium">Refund</th>
                <th className="font-medium">Order</th>
                <th className="font-medium">Amount</th>
                <th className="font-medium">Reason</th>
                <th className="font-medium">Requested by</th>
                <th className="font-medium">Approved by</th>
                <th className="font-medium">Approval</th>
                <th className="font-medium">Executed</th>
              </tr>
            </thead>
            <tbody>
              {refunds.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-3 text-zinc-500">
                    No refunds visible.
                  </td>
                </tr>
              )}
              {refunds.map((r) => (
                <tr key={r.id} className="border-b border-zinc-800/60 last:border-0">
                  <td className="px-4 py-2 font-mono text-zinc-300">{r.id}</td>
                  <td className="font-mono">{r.orderId}</td>
                  <td>{money(r.amount, r.currency)}</td>
                  <td className="text-zinc-400">{r.reason}</td>
                  <td className="font-mono text-zinc-400">{r.requestedBy}</td>
                  <td className="font-mono text-zinc-400">{r.approvedBy}</td>
                  <td className="font-mono text-zinc-500">{r.approvalRequestId ?? "—"}</td>
                  <td className="text-zinc-500">{dateTime(r.createdAt)}</td>
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
