"use client";

import { useRef } from "react";
import { switchDemoUserAction } from "@/app/actions";
import { ROLE_LABEL } from "./badges";

interface DemoUser {
  id: string;
  name: string;
  role: string;
  teamId: string | null;
}

export function UserSwitcher({ users, currentUserId }: { users: DemoUser[]; currentUserId: string | null }) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={switchDemoUserAction} className="space-y-2">
      <label htmlFor="userId" className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-amber-400/90">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Demo identity (dev only)
      </label>
      <select
        id="userId"
        name="userId"
        defaultValue={currentUserId ?? ""}
        onChange={() => formRef.current?.requestSubmit()}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
      >
        <option value="">— Signed out —</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} · {ROLE_LABEL[u.role]}
            {u.teamId ? ` · ${u.teamId}` : ""}
          </option>
        ))}
      </select>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Simulates sign-in with a server-managed session. Not production authentication.
      </p>
    </form>
  );
}
