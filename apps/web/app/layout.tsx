import type { Metadata } from "next";
import type { ReactNode } from "react";
import { countActionableApprovals, listDemoUsers } from "@gatekeeper/core";
import { getDatabase } from "@gatekeeper/database";
import { Nav } from "@/components/nav";
import { RoleBadge } from "@/components/badges";
import { UserSwitcher } from "@/components/user-switcher";
import { getSession } from "@/lib/session";
import { resetDemoAction } from "./actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gatekeeper — Permission-aware MCP agent",
  description: "A demonstration of secure AI agent execution through the Model Context Protocol.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  const users = listDemoUsers(getDatabase());
  const pending = countActionableApprovals(getDatabase(), session?.actor ?? null);

  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="sticky top-0 flex h-screen w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 px-4 py-5">
            <div className="px-2">
              <div className="flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-md bg-emerald-500/15 font-mono text-sm text-emerald-300 ring-1 ring-emerald-500/30">
                  G
                </span>
                <span className="text-base font-semibold text-white">Gatekeeper</span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">Permission-aware MCP server &amp; agent</p>
            </div>

            <Nav pendingApprovals={pending} />

            <div className="mt-auto space-y-4 border-t border-zinc-800 pt-4">
              {session && (
                <div className="px-1">
                  <p className="text-sm font-medium text-zinc-100">{session.actor.name}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <RoleBadge role={session.actor.role} />
                    <span className="font-mono text-[11px] text-zinc-500">{session.actor.id}</span>
                  </div>
                </div>
              )}
              <UserSwitcher
                users={users.map((u) => ({ id: u.id, name: u.name, role: u.role, teamId: u.teamId }))}
                currentUserId={session?.actor.id ?? null}
              />
              <form action={resetDemoAction}>
                <button className="w-full rounded-lg border border-zinc-800 px-2 py-1.5 text-xs text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-300">
                  Reset demo data
                </button>
              </form>
            </div>
          </aside>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
