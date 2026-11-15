import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eq } from "drizzle-orm";
import { auditEvents, createSeededDatabase, refunds, traceEvents } from "@gatekeeper/database";
import { connectInProcess, type ToolResult } from "@gatekeeper/mcp-server";

function setup(userId: string | null, correlationId = "req_mcp_test") {
  const db = createSeededDatabase();
  return { db, connect: () => connectInProcess({ db, principal: { userId, sessionId: "sess_test" }, channel: "mcp", correlationId }) };
}

async function call(client: Client, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  return { isError: Boolean(res.isError), result: res.structuredContent as ToolResult | undefined, text: (res.content as { text: string }[])[0]?.text ?? "" };
}

describe("MCP server (in-process transport)", () => {
  it("advertises the seven tools without any identity parameters", async () => {
    const { connect } = setup("u_alice");
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_approval_status", "get_audit_history", "get_customer", "get_order_status", "list_customer_orders", "request_refund", "update_customer"].sort(),
    );
    for (const tool of tools) {
      const props = Object.keys((tool.inputSchema.properties ?? {}) as object);
      expect(props.some((p) => /user|actor|role|permission/i.test(p))).toBe(false);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
    await close();
  });

  it("returns structured results and audits allowed calls", async () => {
    const { db, connect } = setup("u_alice");
    const { client, close } = await connect();
    const { isError, result } = await call(client, "get_customer", { customerId: 1024 });
    expect(isError).toBe(false);
    expect(result).toMatchObject({ status: "ok", data: { id: 1024 }, authorization: { effect: "allow" } });
    const audit = db.select().from(auditEvents).where(eq(auditEvents.correlationId, "req_mcp_test")).all();
    expect(audit).toEqual([expect.objectContaining({ action: "customer.read", decision: "allow", actorId: "u_alice", channel: "mcp" })]);
    const traces = db.select().from(traceEvents).where(eq(traceEvents.correlationId, "req_mcp_test")).all();
    expect(traces.map((t) => t.type)).toEqual(["mcp.tool_invoked", "authz.evaluated", "mcp.tool_completed"]);
    await close();
  });

  it("enforces customer assignment through MCP", async () => {
    const { connect } = setup("u_alice");
    const { client, close } = await connect();
    const { isError, result } = await call(client, "get_customer", { customerId: 1026 });
    expect(isError).toBe(true);
    expect(result).toMatchObject({ status: "denied", authorization: { effect: "deny", code: "not_assigned" } });
    await close();
  });

  it("ignores identity claims smuggled in arguments or request metadata", async () => {
    const { connect } = setup("u_alice");
    const { client, close } = await connect();
    const smuggled = await call(client, "get_customer", { customerId: 1026, userId: "u_ada" });
    expect(smuggled.isError).toBe(true);
    expect(smuggled.text).toMatch(/Input validation error/);

    const viaMeta = await call(client, "get_customer", { customerId: 1026 }, { userId: "u_ada", role: "admin" });
    expect(viaMeta.result).toMatchObject({ status: "denied" });
    await close();
  });

  it("rejects invalid tool arguments before any business logic runs", async () => {
    const { db, connect } = setup("u_alice");
    const { client, close } = await connect();
    const res = await call(client, "request_refund", { orderId: "5021", amount: -1, currency: "EUR", reason: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Input validation error/);
    expect(db.select().from(refunds).where(eq(refunds.orderId, 5021)).all()).toHaveLength(0);
    await close();
  });

  it("fails closed when the server has no bound principal", async () => {
    const { connect } = setup(null);
    const { client, close } = await connect();
    const { result } = await call(client, "get_customer", { customerId: 1024 });
    expect(result).toMatchObject({ status: "unauthenticated", authorization: { code: "unauthenticated" } });
    await close();
  });

  it("returns pending_approval for refund requests", async () => {
    const { connect } = setup("u_alice");
    const { client, close } = await connect();
    const { isError, result } = await call(client, "request_refund", { orderId: 5021, amount: 120, currency: "EUR", reason: "Damaged" });
    expect(isError).toBe(false);
    expect(result).toMatchObject({ status: "pending_approval", message: "Manager approval required.", authorization: { effect: "requires_approval" } });
    expect(result?.approvalId).toMatch(/^apr_/);
    await close();
  });
});

describe("MCP server (stdio transport)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gatekeeper-"));
  const dbPath = path.join(dir, "test.db");
  createSeededDatabase(dbPath).$client.close();
  const entry = path.resolve("packages/mcp-server/src/transport/stdio.ts");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const transport = (principal?: string) =>
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", entry],
      env: {
        PATH: process.env.PATH ?? "",
        GATEKEEPER_DB_PATH: dbPath,
        GATEKEEPER_LOG_LEVEL: "silent",
        ...(principal ? { GATEKEEPER_DEMO_PRINCIPAL: principal } : {}),
      },
      stderr: "pipe",
    });

  it("serves tools bound to the configured principal", async () => {
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport("u_bob"));
    const allowed = await call(client, "get_customer", { customerId: 1026 });
    expect(allowed.result).toMatchObject({ status: "ok", data: { name: "Priya Shah" } });
    const denied = await call(client, "get_customer", { customerId: 1024 });
    expect(denied.result).toMatchObject({ status: "denied" });
    await client.close();
  });

  it("refuses to start without a principal", async () => {
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await expect(client.connect(transport())).rejects.toThrow();
  });
});
