import { WorldApp } from "./app";
import { loadConfig } from "./config";
import { Db } from "./db/db";
import { createHttpServer } from "./http/server";
import { createChunkStorage } from "./world/chunkStorage";

const cfg = loadConfig();
const db = new Db(cfg.databaseUrl);
const app = new WorldApp({ db, storage: createChunkStorage(cfg), config: cfg });
await app.start();
const { server } = createHttpServer(app);
server.listen(cfg.port, () => {
  console.log(`world-server listening on http://localhost:${cfg.port}  (ws: /ws, dev: /dev)`);
  console.log(`world version ${app.store.version}, committed ${app.store.committedSerial}, allocated ${app.store.worldState.latest_global_serial}, height ${app.store.worldState.height_meters.toFixed(2)} m`);
});
const shutdown = async (): Promise<void> => { console.log("shutting down"); server.close(); await app.stop(); await db.close(); process.exit(0); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
