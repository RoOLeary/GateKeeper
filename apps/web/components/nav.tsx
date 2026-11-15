"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Agent Console", hint: "Chat with the assistant" },
  { href: "/customers", label: "Customer Operations", hint: "Customers, orders, refunds" },
  { href: "/approvals", label: "Approval Queue", hint: "Human-in-the-loop" },
  { href: "/traces", label: "Audit & Traces", hint: "Execution visibility" },
];

export function Nav({ pendingApprovals }: { pendingApprovals: number }) {
  const pathname = usePathname();
  return (
    <nav className="mt-6 space-y-1">
      {LINKS.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`block rounded-lg px-3 py-2 transition ${
              active ? "bg-zinc-800/80 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
          >
            <span className="flex items-center justify-between text-sm font-medium">
              {link.label}
              {link.href === "/approvals" && pendingApprovals > 0 && (
                <span className="rounded-full bg-amber-500/20 px-1.5 text-[11px] text-amber-300">{pendingApprovals}</span>
              )}
            </span>
            <span className="block text-xs text-zinc-500">{link.hint}</span>
          </Link>
        );
      })}
    </nav>
  );
}
