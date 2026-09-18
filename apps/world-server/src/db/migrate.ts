import { loadConfig } from "../config";
import { Db } from "./db";
const db = new Db(loadConfig().databaseUrl);
await db.migrate();
console.log("migrated", db.url.replace(/:[^:@]+@/, ":***@"));
await db.close();
