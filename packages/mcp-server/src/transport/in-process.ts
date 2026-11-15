import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatekeeperMcpServer, type GatekeeperServerOptions } from "../server";

/**
 * Connects an MCP client to a fresh Gatekeeper server over the SDK's in-memory transport.
 *
 * The web app uses this per agent run: the server instance is bound to the principal
 * from the trusted session, so the protocol boundary is real (JSON-RPC messages,
 * schema validation, tool discovery) without spawning a process per request.
 */
export async function connectInProcess(options: GatekeeperServerOptions, clientName = "gatekeeper-agent") {
  const server = createGatekeeperMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
