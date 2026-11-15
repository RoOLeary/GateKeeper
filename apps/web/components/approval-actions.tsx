"use client";

import { useActionState } from "react";
import { decideApprovalAction, type ApprovalActionState } from "@/app/actions";

export function ApprovalActions({
  approvalId,
  canApprove,
  reason,
}: {
  approvalId: string;
  canApprove: boolean;
  reason: string;
}) {
  const [state, action, pending] = useActionState<ApprovalActionState | null, FormData>(decideApprovalAction, null);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="approvalId" value={approvalId} />
      <input
        name="note"
        placeholder="Decision note (optional)"
        maxLength={500}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-zinc-600 focus:border-emerald-500"
      />
      <div className="flex gap-2">
        <button
          name="decision"
          value="approve"
          disabled={pending}
          title={canApprove ? "Approve and execute the refund" : reason}
          className="flex-1 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
        >
          Approve &amp; execute
        </button>
        <button
          name="decision"
          value="reject"
          disabled={pending}
          className="flex-1 rounded-md border border-rose-500/40 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-40"
        >
          Reject
        </button>
      </div>
      {!canApprove && (
        <p className="text-[11px] text-zinc-500">
          Buttons stay enabled on purpose: this preview is advisory, enforcement happens on the server when you submit. Try it.
        </p>
      )}
      {state && (
        <p className={`rounded-md px-2.5 py-1.5 text-xs ${state.ok ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
