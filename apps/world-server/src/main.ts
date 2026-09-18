import { WorldApp } from "./app";
import { loadConfig } from "./config";
import { Db } from "./db/db";
import { createHttpServer } from "./http/server";
import { log } from "./log";
import { createChunkStorage } from "./world/chunkStorage";

const cfg = loadConfig();
const db = new Db(cfg.databaseUrl);
const app = new WorldApp({ db, storage: createChunkStorage(cfg), config: cfg });
await app.start();
const { server } = createHttpServer(app);
server.listen(cfg.port, () => {
  log.info("server.listening", { port: cfg.port, instanceId: cfg.instanceId, storage: cfg.storageKind, worldVersion: app.store.version, committed: app.store.committedSerial, allocated: app.store.worldState.latest_global_serial, heightMeters: app.store.worldState.height_meters });
});
const shutdown = async (): Promise<void> => { log.info("server.shutdown", { instanceId: cfg.instanceId }); server.close(); await app.stop(); await db.close(); process.exit(0); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
