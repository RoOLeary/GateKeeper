import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadActor } from "@gatekeeper/core";
import { getDatabase } from "@gatekeeper/database";
import { logger } from "@gatekeeper/observability";
import { createGatekeeperMcpServer } from "../server";

/**
 * Local stdio entry point for MCP clients (Claude Desktop, Cursor, MCP Inspector…).
 *
 * The server is bound to exactly one principal, configured by the operator via
 * GATEKEEPER_DEMO_PRINCIPAL. A stdio client cannot change it: tool schemas accept no
 * identity fields and the principal is never read from request metadata.
 */
const principalId = process.env.GATEKEEPER_DEMO_PRINCIPAL?.trim();
const db = getDatabase();
const actor = loadActor(db, principalId);

if (!actor) {
  process.stderr.write(
    `gatekeeper-mcp: refusing to start — GATEKEEPER_DEMO_PRINCIPAL ${
      principalId ? `"${principalId}" is not a known user` : "is not set"
    }. Set it to one of: u_alice, u_bob, u_carl, u_maya, u_sam, u_ada.\n`,
  );
  process.exit(1);
}

const server = createGatekeeperMcpServer({
  db,
  principal: { userId: actor.id, sessionId: `stdio:${process.pid}` },
  channel: "mcp-stdio",
});

await server.connect(new StdioServerTransport());
logger.info("mcp.stdio.started", { principal: actor.id, role: actor.role });
