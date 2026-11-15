import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadActor } from "@gatekeeper/core";
import { findWorkspaceRoot, getDatabase } from "@gatekeeper/database";
import { newCorrelationId } from "@gatekeeper/observability";
import { createModelFromEnv } from "./agent";
import { runTurn } from "./orchestration";
import { buildInstructions } from "./prompt";
import { discoverTools } from "./tools";

/**
 * Runs a single agent turn against the *stdio* MCP server in a child process.
 *
 *   GATEKEEPER_DEMO_PRINCIPAL=u_alice pnpm agent:cli "Show customer 1024"
 */
const message = process.argv.slice(2).join(" ").trim();
const principal = process.env.GATEKEEPER_DEMO_PRINCIPAL?.trim();
if (!message || !principal) {
  console.error('Usage: GATEKEEPER_DEMO_PRINCIPAL=<user id> pnpm agent:cli "<request>"');
  process.exit(1);
}

const root = findWorkspaceRoot();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", path.join(root, "packages/mcp-server/src/transport/stdio.ts")],
  env: { ...process.env, GATEKEEPER_DEMO_PRINCIPAL: principal, GATEKEEPER_LOG_LEVEL: "warn" } as Record<string, string>,
  cwd: root,
});
const client = new Client({ name: "gatekeeper-cli", version: "0.1.0" });
await client.connect(transport);

const model = createModelFromEnv();
const tools = await discoverTools(client);
const turn = await runTurn({
  model,
  mcp: client,
  tools,
  instructions: buildInstructions(loadActor(getDatabase(), principal)),
  history: [],
  userMessage: message,
  idempotencySeed: newCorrelationId(),
});

console.log(`\nmodel: ${model.id}   principal: ${principal}   stop: ${turn.stopReason}`);
for (const call of turn.toolCalls) {
  console.log(`  ↳ ${call.name} ${JSON.stringify(call.arguments)} → ${call.status} (${call.durationMs}ms)`);
}
console.log(`\n${turn.reply}\n`);
await client.close();
