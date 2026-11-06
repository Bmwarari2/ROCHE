import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { assertStorageReady } from "./integrations/documents";
import { createLogger } from "./logger";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
// Both buckets checked before the API serves anything (#164 security review, L1).
await assertStorageReady(config);
const { app, close } = createApp(config, logger);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port, version: config.APP_VERSION }, "Harbour API listening");
});

const shutdown = async () => {
  logger.info("shutting down");
  server.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
