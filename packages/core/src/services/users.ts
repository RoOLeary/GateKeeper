import { asc } from "drizzle-orm";
import { users, type Database } from "@gatekeeper/database";

/** Demo-only: the list backing the development user switcher. */
export function listDemoUsers(db: Database) {
  return db.select().from(users).orderBy(asc(users.role), asc(users.name)).all();
}
