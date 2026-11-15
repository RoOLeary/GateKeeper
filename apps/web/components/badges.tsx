import type { ReactNode } from "react";

type Tone = "green" | "red" | "amber" | "sky" | "zinc" | "violet";

const TONES: Record<Tone, string> = {
  green: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  red: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
  amber: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  sky: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
  violet: "bg-violet-500/10 text-violet-300 ring-violet-500/30",
  zinc: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/30",
};

export function Badge({ tone = "zinc", children, mono }: { tone?: Tone; children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONES[tone]} ${
        mono ? "font-mono" : ""
      }`}
    >
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  ok: "green",
  allow: "green",
  approved: "green",
  completed: "green",
  active: "green",
  delivered: "sky",
  shipped: "sky",
  paid: "sky",
  pending: "amber",
  pending_approval: "amber",
  requires_approval: "amber",
  partially_refunded: "violet",
  refunded: "violet",
  denied: "red",
  deny: "red",
  rejected: "red",
  unauthenticated: "red",
  blocked: "red",
  invalidated: "red",
  cancelled: "zinc",
  closed: "zinc",
  suspended: "amber",
  invalid: "red",
  not_found: "zinc",
  conflict: "amber",
  error: "red",
  info: "zinc",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "zinc"}>{status.replaceAll("_", " ")}</Badge>;
}

export const ROLE_LABEL: Record<string, string> = {
  support_agent: "Support Agent",
  manager: "Manager",
  admin: "Administrator",
};

export function RoleBadge({ role }: { role: string }) {
  const tone: Tone = role === "admin" ? "violet" : role === "manager" ? "sky" : "zinc";
  return <Badge tone={tone}>{ROLE_LABEL[role] ?? role}</Badge>;
}
