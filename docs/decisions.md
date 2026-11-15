# Design decisions

Short records of the choices that shaped Gatekeeper: what was decided, why, and what it costs.

---

### 1. One pure `authorize()` function, called by every channel

**Decision.** All rules live in `packages/core/src/authorization/policy.ts`, as a pure function of `(actor, operation, resource, context)`. Services load the facts; `enforce()` adds auditing and tracing. The web UI, MCP tools and approval workflow all go through it.

**Why.** If the web UI and the agent had separate checks, they would drift apart. A pure function can be unit-tested exhaustively and returns an explainable list of checks, which the UI and traces render.

**Cost.** Services must remember to load the right facts *before* calling it. Integration tests cover each path.

### 2. Every refund requires approval (four-eyes), even for admins

**Decision.** `refund.request` always returns `requires_approval`. Approvers need a limit at least as large as the amount, must be in scope, and cannot be the requester.

**Why.** It is the simplest rule that makes the model's ability to move money exactly zero. An "auto-approve under €50" tier would be a natural production feature. It is left out so the demo has a single, clear invariant.

### 3. A fresh in-process MCP server per agent run

**Decision.** The web agent does not call services directly. It creates an `McpServer` bound to the session's principal and connects through `InMemoryTransport.createLinkedPair()`, once per run.

**Why.** The agent then exercises the same MCP tool surface (schemas, envelopes, errors) that external clients use over stdio. Binding at construction makes it structurally impossible for one user's run to reach another user's server instance. Construction is cheap: seven tool registrations.

**Cost.** A small per-request overhead, and in-process means no isolation between the agent and the server. Both are acceptable for a single-process demo.

### 4. Stdio bound to an operator-configured principal; no remote transport

**Decision.** `GATEKEEPER_DEMO_PRINCIPAL` is read once at startup, and the server refuses to start without it. Streamable HTTP is not implemented.

**Why.** Stdio runs locally under the operator's account, so the operator *is* the authority on who it acts as. A remote transport needs real token validation and per-request binding. Shipping a half-secure version would be worse than shipping none. See [security.md](security.md#remote-transports).

### 5. Idempotency keys derived by the agent, enforced by the database

**Decision.** `request_refund` accepts an optional `idempotencyKey`. The agent always supplies one, derived as `sha256(run seed, canonical arguments)`. `UNIQUE(requester_id, idempotency_key)`, `UNIQUE(approval_request_id)` and `UNIQUE(idempotency_key)` on refunds back it up.

**Why.** The requirement was "no retries of non-idempotent operations without an idempotency key". Models do repeat calls. A deterministic key makes those repeats harmless without trusting the model to invent keys. The database constraints mean application bugs cannot double-execute either.

### 6. Pending approvals count against the refundable balance

**Decision.** The refundable balance is the order amount minus executed refunds minus *other pending* requests. It is checked at request time and again at approval time.

**Why.** Otherwise two €200 requests on a €300 order could both be approved. Re-checking at approval catches anything that changed in between.

### 7. Invalidate vs leave pending

**Decision.** If approval fails because of the *resource* (order cancelled, balance gone, account closed), the request becomes `invalidated`. If it fails because of the *approver* (limit, team, self-approval), it stays pending.

**Why.** The first is permanent and should leave the queue. The second just means someone else should decide.

### 8. Offline rule-based model as the default

**Decision.** Without `OPENAI_API_KEY`, the agent uses `OfflineModel`: regex intents → tool calls, with replies rendered only from tool results. It is labelled in the UI as "Offline demo model — rule-based, no LLM".

**Why.** Reviewers can run the full system, including evals, at no cost and deterministically. Because the offline model goes through the identical loop, MCP client, policy and guard, it proves the plumbing. A scripted *adversarial* model in tests proves the security properties.

**Cost.** It is clearly not language understanding, and one eval case is skipped without an LLM. The docs say so rather than overselling it.

### 9. OpenAI Responses API with `store: false` and no parallel tool calls

**Decision.** `OpenAIModel` uses `responses.create` with `store: false` and `parallel_tool_calls: false`. For reasoning models (gpt-5, o-series) it includes `reasoning.encrypted_content` and replays it within the turn.

**Why.** `store: false` keeps customer data out of provider-side state, so conversation history lives in Gatekeeper's database. Sequential calls keep traces readable and budgets exact. Encrypted reasoning items let reasoning models continue across tool calls without server-side storage.

**Cost.** Each turn resends the conversation. That is fine at demo scale.

### 10. A provider-neutral conversation model

**Decision.** The loop speaks a small `ConversationItem` union (`message`, `function_call`, `function_call_output`, `provider_state`). Adapters translate to and from the provider.

**Why.** It makes the loop testable with `ScriptedModel`, and swapping providers touches one file.

### 11. Audit events separate from traces

**Decision.** Two tables and two viewers. Audit records authorization decisions and state changes. Traces record execution steps, timings and model and tool activity.

**Why.** They have different audiences, retention needs and integrity requirements. Mixing them invites either bloated audit logs or traces that are treated as evidence.

### 12. Reply guard instead of trusting the model's prose

**Decision.** `verifyReply` rewrites refund-success claims that tool results don't support, and a fallback reply is built from tool records when the model fails or a limit is hit.

**Why.** "I've processed your refund" is the most damaging possible hallucination in this domain. Approval status is the only source that can confirm execution.

**Cost.** It is a heuristic (English, pattern-based) and is documented as such.

### 13. TypeScript 6, not 7

**Decision.** `typescript ~6.0.3`.

**Why.** TypeScript 7 is the native (Go) compiler. At the time of writing, Next.js and parts of the toolchain still rely on the JavaScript compiler API that 7 doesn't expose. TS 6 is the current JavaScript-API release and supports everything used here (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, bundler resolution).

### 14. Workspace packages export TypeScript source

**Decision.** Each package's `exports` points at `src/index.ts`. Next uses `transpilePackages`, the CLIs run under `tsx`, and Vitest imports source.

**Why.** There is no build step to forget and no stale `dist/`. Types flow directly between packages.

**Cost.** Not publishable as-is. Fine for an application monorepo.

### 15. SQLite with `BEGIN IMMEDIATE`, integer cents, `rowid` ordering

**Decision.** better-sqlite3 (synchronous) with Drizzle; WAL mode; writes in `transaction(fn, { behavior: "immediate" })`; all money in integer cents; timelines ordered by `rowid`.

**Why.** Immediate transactions take the write lock up front, so check-then-write sequences can't interleave. Integer cents avoid floating-point money. `rowid` gives exact insertion order where millisecond timestamps tie.

### 16. Explicit, enabled buttons in the approval queue

**Decision.** The policy preview shows whether *you* may approve, but the buttons stay enabled.

**Why.** It is a demo of server-side enforcement. Hiding the button would suggest the UI is the control. Clicking it shows the server refusing, with the reason and an audit event.

### 17. No rate limiting

**Decision.** Not implemented. Each run is bounded by tool and model budgets and timeouts.

**Why.** It is an orthogonal concern with standard solutions (per-user token buckets at the edge), and it would add infrastructure the brief excluded (no Redis). It is listed as a limitation.
