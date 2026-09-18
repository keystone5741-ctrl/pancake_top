import { Db } from "../src/db/db";
import { ensureWorld } from "../src/world/serial";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://pancake:pancake@127.0.0.1:5432/pancake_test";

export async function freshDb(): Promise<Db> {
  const db = new Db(TEST_DB_URL);
  await db.migrate();
  await db.reset();
  await ensureWorld(db, "world");
  return db;
}
