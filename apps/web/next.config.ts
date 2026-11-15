import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// One .env at the repository root serves the web app, the MCP server and the CLI.
const rootEnv = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@gatekeeper/agent",
    "@gatekeeper/core",
    "@gatekeeper/database",
    "@gatekeeper/mcp-server",
    "@gatekeeper/observability",
  ],
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
};

export default nextConfig;
