import type { ReactNode } from "react";

export function PageHeader({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-800 px-8 py-6">
      <div>
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">{description}</p>
      </div>
      {children}
    </header>
  );
}

export function SignedOut() {
  return (
    <div className="flex h-[70vh] items-center justify-center px-8">
      <div className="max-w-md rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-center">
        <h2 className="text-lg font-semibold text-white">No authenticated identity</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Gatekeeper fails closed: without a trusted session, no data is returned and every tool call is denied. Pick a demo user in
          the sidebar to start a session.
        </p>
      </div>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-zinc-800 bg-zinc-900/40 ${className}`}>{children}</section>;
}
