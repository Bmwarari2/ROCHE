import { ProblemDetails } from "@harbour/contracts";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { z } from "zod";
import type { AppEnv } from "../http/context";
import { problems } from "../http/problem";

export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        const detail = result.error.issues
          .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
          .join("; ");
        throw problems.invalid(detail);
      }
    },
  });
}

export const jsonBody = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const problem = (description: string) => ({
  content: { "application/problem+json": { schema: ProblemDetails } },
  description,
});

/** Standard error responses for tenant-scoped routes. */
export const errorResponses = {
  401: problem("Not signed in"),
  403: problem("Not a member, missing permission, MFA not set up or step-up needed"),
  422: problem("The request did not validate"),
} as const;

export const notFoundResponse = { 404: problem("Not found or outside your access") } as const;

export const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { cookieAuth: [] }];
