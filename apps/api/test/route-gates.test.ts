import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { type AppEnv, SCOPE_WITHOUT_PERMISSION, useScopeOf } from "../src/http/context";

/**
 * Hazard HZ-011 (ADR-0071 review round 1, L12): every route handler that opens a tenant
 * transaction first requires a permission (`requirePermission`, `requireAnyPermission`) or runs in
 * one listed permission's scope (`useScopeOf`), so it never reads people under a scope it did not
 * ask for. A static scan of the route sources, with its limits:
 * - it follows calls by function name to functions declared in apps/api/src (routes, services and
 *   http), not calls through variables, callbacks, objects or other packages;
 * - "first" is by position in the source, not by control flow: a gate inside a branch counts;
 * - a database is opened by `withTenant` or `withRequestContext` only; a handler reaching the
 *   database another way (a pool, `inSystemView`) is not seen.
 * The routes that open a transaction with no gate are listed below with why; the list must match
 * exactly, so a new ungated route, or a stale entry, fails.
 */

const GATES = new Set(["requirePermission", "requireAnyPermission", "useScopeOf"]);
const DATABASE = new Set(["withTenant", "withRequestContext"]);

const UNGATED: Readonly<Record<string, string>> = {
  "GET /v1/me": "the member's own memberships and roles; scope 'none'",
  "GET /v1/branding":
    "the organisation's white-label name, accent and logo id (PLAT-002); no personal data",
  "GET /v1/branding/logo": "the organisation's logo (PLAT-002); about no one; scope 'none'",
  "GET /v1/forms/templates": "the organisation's form templates; no personal data; scope 'none'",
  "GET /v1/rates/{key}": "a rate-table figure; no personal data; scope 'none'",
  "GET /v1/notifications": "the member's own notifications (notification_recipient policy)",
  "POST /v1/notifications/{id}/acknowledge": "the member's own notification",
  "POST /v1/notifications/{id}/read": "the member's own notification",
  "POST /v1/sync/device-report":
    "any member reports what their device holds; written in the system's view (HZ-006)",
  "POST /v1/sync/upload": "refuses every operation (no writable synced tables); audits the count",
  "POST /p/evidence/code":
    "a public evidence pack link: no member; runs as the link session (migration 0058), that link alone",
  "POST /p/evidence/verify": "a public evidence pack link: the link session, that link alone",
  "GET /p/evidence/bundle": "a public evidence pack link: the signed session cookie's link alone",
  "POST /operator/tenants": "an operator route behind the operator middleware, not a tenant route",
  "POST /operator/tenants/{tenantId}/support-access": "an operator route (support access request)",
  "POST /operator/sub-processor-notices":
    "an operator route (announcing a notice; each organisation read in its own context)",
  "POST /operator/tenants/{tenantId}/owner-invitation":
    "an operator route (the first owner's invitation, through app.invite_first_owner)",
};

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourcesIn(dir: string): ts.SourceFile[] {
  return readdirSync(join(SRC, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) =>
      ts.createSourceFile(
        join(dir, f),
        readFileSync(join(SRC, dir, f), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ),
    );
}

const routes = sourcesIn("routes");
const all = [...routes, ...sourcesIn("services"), ...sourcesIn("http")];

/** Functions declared at the top level of a file, by name. */
const functions = new Map<string, ts.Node>();
for (const file of all) {
  file.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          functions.set(d.name.text, d.initializer);
        }
      }
    }
  });
}

function calls(node: ts.Node): { name: string; pos: number }[] {
  const found: { name: string; pos: number }[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const name = ts.isIdentifier(e)
        ? e.text
        : ts.isPropertyAccessExpression(e)
          ? e.name.text
          : "";
      if (name) found.push({ name, pos: n.getStart() });
    }
    n.forEachChild(walk);
  };
  walk(node);
  return found;
}

/** Whether a function (or what it calls) gates, and whether it opens the database. */
const summaries = new Map<string, { gate: boolean; database: boolean }>();
function summary(name: string, seen = new Set<string>()): { gate: boolean; database: boolean } {
  const known = summaries.get(name);
  if (known) return known;
  const fn = functions.get(name);
  if (!fn || seen.has(name)) return { gate: false, database: false };
  seen.add(name);
  const result = { gate: false, database: false };
  for (const c of calls(fn)) {
    if (GATES.has(c.name)) result.gate = true;
    else if (DATABASE.has(c.name)) result.database = true;
    else if (functions.has(c.name)) {
      const s = summary(c.name, seen);
      result.gate ||= s.gate;
      result.database ||= s.database;
    }
  }
  summaries.set(name, result);
  return result;
}

interface RouteFinding {
  readonly route: string;
  readonly gate: number;
  readonly database: number;
}

function routeFindings(): RouteFinding[] {
  const findings: RouteFinding[] = [];
  for (const file of routes) {
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "openapi" &&
        n.arguments.length >= 2
      ) {
        const [definition, handler] = n.arguments as unknown as [ts.Node, ts.Node];
        const text = definition.getText();
        const method = /method:\s*"(\w+)"/.exec(text)?.[1]?.toUpperCase() ?? "?";
        const path = /path:\s*"([^"]+)"/.exec(text)?.[1] ?? "?";
        let gate = Number.POSITIVE_INFINITY;
        let database = Number.POSITIVE_INFINITY;
        for (const c of calls(handler)) {
          if (GATES.has(c.name)) gate = Math.min(gate, c.pos);
          else if (DATABASE.has(c.name)) database = Math.min(database, c.pos);
          else if (functions.has(c.name)) {
            const s = summary(c.name);
            if (s.gate) gate = Math.min(gate, c.pos);
            if (s.database) database = Math.min(database, c.pos);
          }
        }
        findings.push({ route: `${method} ${path}`, gate, database });
      }
      n.forEachChild(visit);
    };
    visit(file);
  }
  return findings;
}

describe("hazard HZ-011 every route asks for a permission's scope before the database (review round 1, L12)", () => {
  const findings = routeFindings();

  it("finds the routes", () => {
    expect(findings.length).toBeGreaterThan(150);
    expect(findings.every((f) => !f.route.includes("?"))).toBe(true);
  });

  it("gates every route that opens a tenant transaction, but the listed ones", () => {
    const ungated = findings
      .filter((f) => f.database < Number.POSITIVE_INFINITY && !(f.gate <= f.database))
      .map((f) => f.route)
      .sort();
    expect(ungated).toEqual(Object.keys(UNGATED).sort());
  });

  it("lists in SCOPE_WITHOUT_PERMISSION only routes that exist", () => {
    const known = findings.map((f) => f.route.replace(/\{(\w+)\}/g, ":$1"));
    for (const route of Object.keys(SCOPE_WITHOUT_PERMISSION)) expect(known).toContain(route);
  });
});

describe("useScopeOf", () => {
  /** Runs useScopeOf in a handler registered for `route` with `register`, asked with `method`. */
  const run = async (
    register: "get" | "post",
    method: string,
    route: string,
    path: string,
    permission: string,
  ) => {
    const app = new Hono<AppEnv>();
    let outcome = "not run";
    app[register](route, (c) => {
      c.set("access", {
        effective: { permissions: new Set(), scopes: new Map(), roleKeys: [], session: "staff" },
        required: [],
        context: { tenantId: "t", userId: "u", scope: "none", locationIds: [] },
      } as unknown as AppEnv["Variables"]["access"]);
      try {
        useScopeOf(c, permission as Parameters<typeof useScopeOf>[1]);
        outcome = "allowed";
      } catch (error) {
        outcome = (error as Error).message;
      }
      return c.text("");
    });
    await app.request(path, { method });
    return outcome;
  };

  it("refuses a route not listed, and a listed route with another permission", async () => {
    expect(await run("get", "GET", "/v1/people/:id", "/v1/people/1", "people.person.read")).toMatch(
      /may not run in the scope/,
    );
    expect(await run("get", "GET", "/v1/tasks", "/v1/tasks", "care.note.read")).toMatch(
      /may not run in the scope/,
    );
  });

  it("allows a listed route, and a HEAD request as its GET route (L5)", async () => {
    expect(await run("get", "GET", "/v1/tasks", "/v1/tasks", "people.person.read")).toBe("allowed");
    expect(
      await run(
        "get",
        "HEAD",
        "/v1/documents/:id/content",
        "/v1/documents/1/content",
        "people.person.read",
      ),
    ).toBe("allowed");
  });
});
