import { DeviceSessionList } from "@harbour/contracts";
import { authSession } from "@harbour/db";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Context } from "hono";
import type { AppEnv, SessionInfo } from "../http/context";
import { problems } from "../http/problem";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * The devices where the signed-in person is signed in (section 9.1, device management). These
 * belong to the identity, not to an organisation, so no tenant header is needed. Sessions are
 * found by id; the session token, a full credential, never leaves the API.
 */

function requireSession(c: Context<AppEnv>): SessionInfo {
  const session = c.get("session");
  if (!session) throw problems.unauthenticated();
  return session;
}

export const sessionsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/sessions",
      tags: ["platform"],
      summary: "Devices where you are signed in",
      security,
      responses: {
        200: jsonBody(DeviceSessionList, "Signed-in devices"),
        401: errorResponses[401],
      },
    }),
    async (c) => {
      const session = requireSession(c);
      const db = drizzle(c.get("services").authPool);
      const rows = await db
        .select({
          id: authSession.id,
          userAgent: authSession.userAgent,
          createdAt: authSession.createdAt,
          updatedAt: authSession.updatedAt,
          expiresAt: authSession.expiresAt,
        })
        .from(authSession)
        .where(
          and(eq(authSession.userId, session.authUserId), gt(authSession.expiresAt, new Date())),
        )
        .orderBy(asc(authSession.createdAt));
      return c.json(
        {
          items: rows.map((r) => ({
            id: r.id,
            device: r.userAgent,
            createdAt: r.createdAt.toISOString(),
            lastActiveAt: r.updatedAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
            current: r.id === session.sessionId,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/me/sessions/{id}/revoke",
      tags: ["platform"],
      summary: "Sign out one of your devices",
      security,
      request: { params: z.object({ id: z.string().min(1).max(200) }) },
      responses: {
        204: { description: "Signed out" },
        401: errorResponses[401],
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const session = requireSession(c);
      const { id } = c.req.valid("param");
      const db = drizzle(c.get("services").authPool);
      const removed = await db
        .delete(authSession)
        .where(and(eq(authSession.id, id), eq(authSession.userId, session.authUserId)))
        .returning({ id: authSession.id });
      if (removed.length === 0) throw problems.notFound();
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/me/sessions/revoke-others",
      tags: ["platform"],
      summary: "Sign out every device except this one",
      security,
      responses: {
        200: jsonBody(z.object({ revoked: z.number().int() }), "Devices signed out"),
        401: errorResponses[401],
      },
    }),
    async (c) => {
      const session = requireSession(c);
      const db = drizzle(c.get("services").authPool);
      const removed = await db
        .delete(authSession)
        .where(
          and(eq(authSession.userId, session.authUserId), ne(authSession.id, session.sessionId)),
        )
        .returning({ id: authSession.id });
      return c.json({ revoked: removed.length }, 200);
    },
  );
