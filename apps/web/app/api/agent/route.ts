import { NextResponse } from "next/server";
import { z } from "zod";
import { clearConversation, runAgent } from "@gatekeeper/agent";
import { getDatabase } from "@gatekeeper/database";
import { logger } from "@gatekeeper/observability";
import { getSession } from "@/lib/session";

const Body = z.strictObject({ message: z.string().trim().min(1).max(2_000) });

/**
 * Runs one agent turn. The principal comes exclusively from the server-side session;
 * the request body carries only the user's message.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Select a demo user first." }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Message must be 1–2000 characters." }, { status: 400 });

  try {
    const message = await runAgent({
      db: getDatabase(),
      session: { sessionId: session.sessionId, userId: session.actor.id },
      message: parsed.data.message,
    });
    return NextResponse.json({ message });
  } catch (error) {
    logger.error("agent.run_failed", { error: String(error), sessionId: session.sessionId });
    return NextResponse.json({ error: "The agent failed to run. No changes were made." }, { status: 500 });
  }
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  clearConversation(getDatabase(), session.sessionId);
  return NextResponse.json({ ok: true });
}
