import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

export type Database = BetterSQLite3Database<typeof schema> & { $client: BetterSqlite3.Database };

/** Either the root database handle or an open transaction. */
export type DbExecutor = BaseSQLiteDatabase<"sync", BetterSqlite3.RunResult, typeof schema>;

/**
 * Walks up until it finds the pnpm workspace root. Starts from the working directory and
 * falls back to this module's location, because MCP clients may launch the stdio server
 * from an unrelated directory.
 */
export function findWorkspaceRoot(start?: string): string {
  const candidates = start ? [start] : [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const candidate of candidates) {
    const root = walkUpToWorkspace(candidate);
    if (root) return root;
  }
  throw new Error(`Could not locate workspace root from ${candidates.join(" or ")}`);
}

function walkUpToWorkspace(start: string): string | null {
  let dir = path.resolve(/*turbopackIgnore: true*/ start);
  while (true) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function defaultDatabasePath(): string {
  return process.env.GATEKEEPER_DB_PATH ?? path.join(findWorkspaceRoot(), "data", "gatekeeper.db");
}

function migrationsFolder(): string {
  return path.join(findWorkspaceRoot(), "packages", "database", "migrations");
}

export function openDatabase(filename: string): Database {
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = new BetterSqlite3(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return drizzle({ client: sqlite, schema }) as Database;
}

export function migrateDatabase(db: Database): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}

const globalForDb = globalThis as unknown as { __gatekeeperDb?: Database };

/**
 * Process-wide database handle for the app and the stdio MCP server.
 * Cached on globalThis so Next.js hot reloads do not leak connections.
 */
export function getDatabase(): Database {
  if (!globalForDb.__gatekeeperDb) {
    const db = openDatabase(defaultDatabasePath());
    migrateDatabase(db);
    globalForDb.__gatekeeperDb = db;
  }
  return globalForDb.__gatekeeperDb;
}
