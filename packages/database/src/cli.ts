import { count } from "drizzle-orm";
import { defaultDatabasePath, migrateDatabase, openDatabase } from "./client";
import { users } from "./schema";
import { seedDatabase } from "./seed";

const command = process.argv[2];
const filename = defaultDatabasePath();
const db = openDatabase(filename);
migrateDatabase(db);

if (command === "reset") {
  seedDatabase(db);
  console.log(`Database reset with demo data: ${filename}`);
} else if (command === "setup") {
  const [row] = db.select({ n: count() }).from(users).all();
  if (!row || row.n === 0) {
    seedDatabase(db);
    console.log(`Database created and seeded: ${filename}`);
  } else {
    console.log(`Database already initialised: ${filename} (run \`pnpm db:reset\` to restore demo data)`);
  }
} else {
  console.error("Usage: cli.ts <setup|reset>");
  process.exit(1);
}

db.$client.close();
