import { randomUUID } from "node:crypto";
import { createDatabase, createPool } from "@harbour/db";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createAuth } from "./auth/better-auth";
import type { Config } from "./config";
import { type AppEnv, type Services, sessionMiddleware, tenantMiddleware } from "./http/context";
import { HttpProblem, problemResponse, problems } from "./http/problem";
import type { Logger } from "./logger";
import { membershipsRouter, meRouter } from "./routes/me";
import { createRouter } from "./routes/openapi";
import { peopleRouter } from "./routes/people";
import {
  auditRouter,
  formsRouter,
  healthRouter,
  notificationsRouter,
  ratesRouter,
} from "./routes/platform";
import { createSyncRouter } from "./routes/sync";
import { SyncTokenSigner } from "./sync/token";

/** Routes that need a session but not yet a chosen tenant, or no session at all. */
const TENANTLESS = new Set(["/v1/memberships", "/v1/sync/jwks"]);

export interface AppHandle {
  readonly app: ReturnType<typeof createRouter>;
  readonly services: Services;
  readonly signer: SyncTokenSigner;
  close(): Promise<void>;
}

export function createApp(config: Config, logger: Logger): AppHandle {
  const appPool = createPool(config.DATABASE_APP_URL);
  const authPool = createPool(config.DATABASE_AUTH_URL, { max: 5 });
  const services: Services = {
    config,
    logger,
    db: createDatabase(appPool),
    appPool,
    authPool,
    auth: createAuth(config, authPool),
  };
  const signer = new SyncTokenSigner(config.SYNC_SIGNING_KEY_ID, config.SYNC_SIGNING_KEY_PEM);

  const app = createRouter();

  app.use("*", async (c, next) => {
    c.set("services", services);
    c.set("requestId", c.req.header("x-request-id") ?? randomUUID());
    await next();
    c.header("x-request-id", c.get("requestId"));
  });
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: [...config.webOrigins],
      credentials: true,
      allowHeaders: [
        "authorization",
        "content-type",
        "x-harbour-tenant",
        "x-harbour-device",
        "x-request-id",
      ],
      exposeHeaders: ["set-auth-token", "x-request-id"],
      maxAge: 600,
    }),
  );

  app.on(["GET", "POST"], "/api/auth/*", (c) => services.auth.handler(c.req.raw));

  app.use("/v1/*", sessionMiddleware);
  app.use("/v1/*", async (c, next) => {
    if (TENANTLESS.has(c.req.path)) return next();
    return tenantMiddleware(c, next);
  });

  app.route("/", healthRouter);
  app.route("/", membershipsRouter);
  app.route("/", meRouter);
  app.route("/", peopleRouter);
  app.route("/", notificationsRouter);
  app.route("/", auditRouter);
  app.route("/", formsRouter);
  app.route("/", ratesRouter);
  app.route("/", createSyncRouter(signer));

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Session token from the set-auth-token header (mobile app)",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "harbour.session_token",
    description: "Session cookie (web app)",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Harbour API",
      version: config.APP_VERSION,
      description:
        "Internal API for the Harbour web and mobile apps. Every request is scoped to one organisation (x-harbour-tenant) and enforced again by Postgres row-level security.",
    },
    servers: [{ url: config.BETTER_AUTH_URL }],
  });

  app.notFound((c) => problemResponse(c, problems.notFound(), c.get("requestId")));
  app.onError((error, c) => {
    if (error instanceof HttpProblem) return problemResponse(c, error, c.get("requestId"));
    // Opaque identifiers only: the error message may contain data, so log its name and stack.
    logger.error(
      { requestId: c.get("requestId"), err: { name: error.name, stack: error.stack } },
      "request failed",
    );
    return problemResponse(
      c,
      new HttpProblem(500, "internal", "Something went wrong on our side. Try again in a moment."),
      c.get("requestId"),
    );
  });

  return {
    app,
    services,
    signer,
    close: async () => {
      await Promise.all([appPool.end(), authPool.end()]);
    },
  };
}

export type { AppEnv };
