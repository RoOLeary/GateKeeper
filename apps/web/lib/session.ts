import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { loadActor, type Actor } from "@gatekeeper/core";
import { getDatabase, sessions } from "@gatekeeper/database";
import { newId } from "@gatekeeper/observability";

/**
 * DEVELOPMENT-ONLY demo authentication.
 *
 * The demo user switcher creates a real server-managed session: a random token in an
 * httpOnly cookie, with only its SHA-256 hash stored in SQLite. Identity for every
 * request — including agent runs and MCP tool calls — is derived from this session,
 * never from the browser, the prompt or the model. A production system would replace
 * the switcher with a real identity provider; the rest of the chain stays the same.
 */
const COOKIE = "gk_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface WebSession {
  sessionId: string;
  actor: Actor;
}

export async function getSession(): Promise<WebSession | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const db = getDatabase();
  const row = db.select().from(sessions).where(eq(sessions.tokenHash, hash(token))).get();
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) return null;
  const actor = loadActor(db, row.userId);
  return actor ? { sessionId: row.id, actor } : null;
}

export async function startDemoSession(userId: string): Promise<WebSession | null> {
  const db = getDatabase();
  const actor = loadActor(db, userId);
  if (!actor) return null;

  const jar = await cookies();
  const previous = jar.get(COOKIE)?.value;
  if (previous) db.delete(sessions).where(eq(sessions.tokenHash, hash(previous))).run();

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const sessionId = newId("sess");
  db.insert(sessions)
    .values({
      id: sessionId,
      tokenHash: hash(token),
      userId: actor.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    })
    .run();

  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return { sessionId, actor };
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) getDatabase().delete(sessions).where(eq(sessions.tokenHash, hash(token))).run();
  jar.delete(COOKIE);
}
