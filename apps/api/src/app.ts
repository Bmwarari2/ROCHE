import { randomUUID } from "node:crypto";
import { createDatabase, createPool } from "@harbour/db";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createAuth } from "./auth/better-auth";
import { withoutSessionTokens } from "./auth/token-exposure";
import type { Config } from "./config";
import { createFlagService } from "./flags/provider";
import { type AppEnv, type Services, sessionMiddleware, tenantMiddleware } from "./http/context";
import { HttpProblem, problemResponse, problems } from "./http/problem";
import { QuotaExceeded } from "./http/quota";
import { RateLimiter } from "./http/rate-limit";
import { MemoryThrottle } from "./http/throttle";
import { MockEmail, MockPush, MockSms } from "./integrations/adapters";
import { createDocumentServices } from "./integrations/documents";
import { createAdapterResolver } from "./integrations/registry";
import { idleErrorLogger, type Logger } from "./logger";
import { breakGlassReportRouter } from "./routes/break-glass-report";
import { breakGlassSearchRouter } from "./routes/break-glass-search";
import { careRouter } from "./routes/care";
import { carePlansRouter } from "./routes/care-plans";
import { careRecordsRouter } from "./routes/care-records";
import { careSettingsRouter } from "./routes/care-settings";
import { devicesRouter } from "./routes/devices";
import { documentsRouter } from "./routes/documents";
import { dpiaRouter } from "./routes/dpia";
import { evidenceLinkRouter } from "./routes/evidence-link";
import { evidencePacksRouter } from "./routes/evidence-packs";
import { exportsRouter } from "./routes/exports";
import { familyFeedRouter } from "./routes/family-feed";
import { feedPublishRouter } from "./routes/feed-publish";
import { handoversRouter } from "./routes/handovers";
import { incidentsRouter } from "./routes/incidents";
import { integrationsRouter, supportAccessRouter } from "./routes/integrations";
import { invitationsRouter } from "./routes/invitations";
import { letterTemplatesRouter } from "./routes/letter-templates";
import { lettersRouter } from "./routes/letters";
import { mcaRouter } from "./routes/mca";
import { membershipsRouter, meRouter } from "./routes/me";
import { memberSessionsRouter } from "./routes/member-sessions";
import { membersRouter } from "./routes/members";
import { onboardingRouter } from "./routes/onboarding";
import { createRouter } from "./routes/openapi";
import { operationsRouter } from "./routes/operations";
import { operatorMiddleware, operatorRouter } from "./routes/operator";
import { operatorInvitationsRouter } from "./routes/operator-invitations";
import { operatorSubProcessorsRouter } from "./routes/operator-sub-processors";
import { outagesRouter } from "./routes/outages";
import { peopleRouter } from "./routes/people";
import { peopleDetailsRouter } from "./routes/people-details";
import { peopleExitRouter } from "./routes/people-exit";
import { peopleLifecycleRouter } from "./routes/people-lifecycle";
import { peoplePropertyRouter } from "./routes/people-property";
import { peopleRecordsRouter } from "./routes/people-records";
import { peopleSharingRouter } from "./routes/people-sharing";
import { peopleTransfersRouter } from "./routes/people-transfers";
import {
  auditRouter,
  formsRouter,
  healthRouter,
  notificationsRouter,
  ratesRouter,
} from "./routes/platform";
import { createRefusedEntriesRouter } from "./routes/refused-entries";
import { roundsRouter } from "./routes/rounds";
import { safeguardingRouter } from "./routes/safeguarding";
import { sampleDataRouter } from "./routes/sample-data";
import { searchRouter } from "./routes/search";
import { sessionsRouter } from "./routes/sessions";
import { statementOfPurposeRouter } from "./routes/statement-of-purpose";
import { statutoryNotificationsRouter } from "./routes/statutory-notifications";
import { subProcessorsRouter } from "./routes/sub-processors";
import { createSyncRouter } from "./routes/sync";
import { tasksRouter } from "./routes/tasks";
import { SyncTokenSigner } from "./sync/token";

/** Largest upload accepted at the edge of the API; each category has its own lower limit. */
const MAX_UPLOAD_BYTES = 26 * 1024 * 1024;
/** Largest body any /v1/sync route accepts (security review round 4, M4). */
export const SYNC_MAX_BODY_BYTES = 64 * 1024;

/** Routes that need a session but not yet a chosen tenant, or no session at all. */
const TENANTLESS = new Set([
  "/v1/memberships",
  "/v1/sync/jwks",
  // An invitation link is opened and accepted before the person belongs to the organisation.
  "/v1/invitations/lookup",
  "/v1/invitations/accept",
]);
/** Identity-level routes: the person's own devices, whatever organisation they work in. */
const isTenantless = (path: string) => TENANTLESS.has(path) || path.startsWith("/v1/me/sessions");

export interface AppHandle {
  readonly app: ReturnType<typeof createRouter>;
  readonly services: Services;
  readonly signer: SyncTokenSigner;
  close(): Promise<void>;
}

export function createApp(config: Config, logger: Logger): AppHandle {
  const appPool = createPool(config.DATABASE_APP_URL, {}, idleErrorLogger(logger, "app"));
  const authPool = createPool(
    config.DATABASE_AUTH_URL,
    { max: 5 },
    idleErrorLogger(logger, "auth"),
  );
  const operatorPool = createPool(
    config.DATABASE_OPERATOR_URL,
    { max: 3 },
    idleErrorLogger(logger, "operator"),
  );
  const mocks = { email: new MockEmail(), sms: new MockSms(), push: new MockPush() };
  const services: Services = {
    config,
    logger,
    db: createDatabase(appPool),
    appPool,
    authPool,
    operatorPool,
    auth: createAuth(config, authPool),
    flags: createFlagService(config, logger),
    ...createDocumentServices(config),
    transferPackLimiter: new RateLimiter(
      "transfer_pack",
      config.TRANSFER_PACK_REQUESTS_PER_MINUTE,
      60_000,
    ),
    accountDeletionLimiter: new RateLimiter(
      "account_deletion",
      config.ACCOUNT_DELETION_REQUESTS_PER_DAY,
      24 * 3_600_000,
    ),
    handoverCompileLimiter: new RateLimiter(
      "handover_compile",
      config.HANDOVER_COMPILE_REQUESTS_PER_MINUTE,
      60_000,
    ),
    adapterFor: createAdapterResolver({ production: config.NODE_ENV === "production", mocks }),
    mockEmail: mocks.email,
    evidenceLinkThrottles: {
      address: new MemoryThrottle(config.EVIDENCE_LINK_REQUESTS_PER_MINUTE_PER_ADDRESS, 60_000),
      link: new MemoryThrottle(config.EVIDENCE_LINK_REQUESTS_PER_MINUTE_PER_LINK, 60_000),
    },
    invitationThrottles: {
      address: new MemoryThrottle(config.INVITATION_REQUESTS_PER_MINUTE_PER_ADDRESS, 60_000),
      token: new MemoryThrottle(config.INVITATION_REQUESTS_PER_MINUTE_PER_TOKEN, 60_000),
    },
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
      // set-auth-token is not exposed: browsers never receive session tokens (token-exposure.ts).
      exposeHeaders: ["x-request-id"],
      maxAge: 600,
    }),
  );

  app.on(["GET", "POST"], "/api/auth/*", async (c) =>
    withoutSessionTokens(c.req.raw, await services.auth.handler(c.req.raw)),
  );

  // Responses may hold personal data: never cache them in browsers, proxies or devices.
  app.use("/v1/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  // Uploads are capped before they are read (largest category limit plus headroom; ASVS V5).
  for (const path of ["/v1/documents", "/v1/documents/*", "/v1/people/:id/photo"]) {
    app.use(
      path,
      bodyLimit({
        maxSize: MAX_UPLOAD_BYTES,
        onError: (c) =>
          problemResponse(c, new HttpProblem(413, "too_large", "The file is too large.")),
      }),
    );
  }
  // Sync bodies are small JSON (a token request, a batch of changes, a deletion record, a device
  // report): anything larger is refused before it is read (security review round 4, M4).
  app.use(
    "/v1/sync/*",
    bodyLimit({
      maxSize: SYNC_MAX_BODY_BYTES,
      onError: (c) =>
        problemResponse(c, new HttpProblem(413, "too_large", "The request is too large.")),
    }),
  );
  // The public evidence pack link routes (ADR-0050): no session, never cached.
  app.use("/p/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  app.use("/v1/*", sessionMiddleware);
  app.use("/operator/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  app.use("/operator/*", sessionMiddleware);
  app.use("/operator/*", operatorMiddleware);
  app.use("/v1/*", async (c, next) => {
    if (isTenantless(c.req.path)) return next();
    return tenantMiddleware(c, next);
  });

  app.route("/", healthRouter);
  app.route("/", membershipsRouter);
  app.route("/", meRouter);
  app.route("/", searchRouter);
  app.route("/", breakGlassSearchRouter);
  app.route("/", sessionsRouter);
  app.route("/", memberSessionsRouter);
  app.route("/", peopleRouter);
  app.route("/", peopleLifecycleRouter);
  app.route("/", peoplePropertyRouter);
  app.route("/", peopleRecordsRouter);
  app.route("/", peopleTransfersRouter);
  app.route("/", peopleExitRouter);
  app.route("/", peopleSharingRouter);
  app.route("/", breakGlassReportRouter);
  app.route("/", notificationsRouter);
  app.route("/", auditRouter);
  app.route("/", formsRouter);
  app.route("/", tasksRouter);
  app.route("/", documentsRouter);
  app.route("/", careRouter);
  app.route("/", carePlansRouter);
  app.route("/", careRecordsRouter);
  app.route("/", careSettingsRouter);
  app.route("/", roundsRouter);
  app.route("/", handoversRouter);
  app.route("/", mcaRouter);
  app.route("/", incidentsRouter);
  app.route("/", safeguardingRouter);
  app.route("/", statutoryNotificationsRouter);
  app.route("/", operationsRouter);
  app.route("/", outagesRouter);
  app.route("/", evidencePacksRouter);
  app.route("/", statementOfPurposeRouter);
  app.route("/", evidenceLinkRouter);
  app.route("/", letterTemplatesRouter);
  app.route("/", familyFeedRouter);
  app.route("/", feedPublishRouter);
  app.route("/", lettersRouter);
  app.route("/", ratesRouter);
  app.route("/", createSyncRouter(signer));
  app.route("/", devicesRouter);
  app.route("/", createRefusedEntriesRouter());
  app.route("/", integrationsRouter);
  app.route("/", supportAccessRouter);
  app.route("/", operatorRouter);
  app.route("/", invitationsRouter);
  app.route("/", membersRouter);
  app.route("/", exportsRouter);
  app.route("/", dpiaRouter);
  app.route("/", subProcessorsRouter);
  app.route("/", onboardingRouter);
  app.route("/", sampleDataRouter);
  app.route("/", operatorInvitationsRouter);
  app.route("/", operatorSubProcessorsRouter);
  app.route("/", peopleDetailsRouter);

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
    if (error instanceof HttpProblem) {
      const response = problemResponse(c, error, c.get("requestId"));
      if (error instanceof QuotaExceeded) {
        response.headers.set("retry-after", String(error.retryAfterSeconds));
      }
      return response;
    }
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
      await Promise.all([appPool.end(), authPool.end(), operatorPool.end()]);
    },
  };
}

export type { AppEnv };
