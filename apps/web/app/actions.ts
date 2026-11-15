"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { decideApproval, isServiceError } from "@gatekeeper/core";
import { getDatabase, seedDatabase } from "@gatekeeper/database";
import { logger, newCorrelationId, recordAudit } from "@gatekeeper/observability";
import { webContext } from "@/lib/context";
import { endSession, getSession, startDemoSession } from "@/lib/session";

/** DEVELOPMENT ONLY: switch the simulated signed-in user. */
export async function switchDemoUserAction(formData: FormData): Promise<void> {
  const userId = String(formData.get("userId") ?? "");
  if (!userId) {
    await endSession();
  } else {
    const session = await startDemoSession(userId);
    if (session) {
      recordAudit(getDatabase(), {
        actor: session.actor,
        action: "session.demo_switch",
        decision: "allow",
        reason: "Development-only demo user switch",
        correlationId: newCorrelationId(),
        channel: "web",
      });
    }
  }
  revalidatePath("/", "layout");
}

export interface ApprovalActionState {
  ok: boolean;
  message: string;
}

export async function decideApprovalAction(_prev: ApprovalActionState | null, formData: FormData): Promise<ApprovalActionState> {
  const session = await getSession();
  const ctx = webContext(session, { trace: true });
  const decision = String(formData.get("decision"));
  const approvalId = String(formData.get("approvalId") ?? "");
  ctx.tracer?.event("request.received", { name: `approval.${decision}`, attributes: { channel: "web" } });
  try {
    decideApproval(ctx, { approvalId, decision, note: String(formData.get("note") ?? "").trim() || undefined });
  } catch (error) {
    if (isServiceError(error)) return { ok: false, message: error.message };
    logger.error("approval.action_failed", { error: String(error), correlationId: ctx.correlationId });
    return { ok: false, message: "Something went wrong. No changes were made." };
  }
  revalidatePath("/", "layout");
  redirect(`/approvals?decided=${encodeURIComponent(approvalId)}`);
}

/** Restores the deterministic demo dataset (also clears sessions, so everyone is signed out). */
export async function resetDemoAction(): Promise<void> {
  seedDatabase(getDatabase());
  await endSession();
  revalidatePath("/", "layout");
}
