import { createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProblemDetails } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import {
  ALL_PERMISSIONS,
  type Permission,
  requiresStepUp,
  touchesCareRecords,
} from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { factorIdentifier } from "../src/auth/session-factor";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import { refusalOf, stepUpFresh, type TenantAccess } from "../src/http/context";
import { ageSession, createHarness, type Harness, LODGE, PASSWORD } from "./support/harness";

/**
 * Hazard HZ-112 (ADR-0072 amendment): step-up needs a second factor (a passkey, an authenticator
 * code or a backup code) used on this session within `STEP_UP_WINDOW_SECONDS`. A password sign-in,
 * however recent, never counts; a member with no factor enrolled is asked to set one up.
 */

const WINDOW = 600;
const NOW = new Date("2026-10-16T09:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const STEP_UP = ALL_PERMISSIONS.filter(requiresStepUp);

/** A member holding just `permission`, as the tenant middleware would build them. */
function accessWith(
  permission: Permission,
  factor: { readonly enrolled: boolean; readonly usedAt: Date | null },
): TenantAccess {
  return {
    tenantId: DEMO.tenantId,
    tenantUserId: DEMO.users.manager.id,
    session: {
      authUserId: "auth-user",
      sessionId: "session",
      name: "Ada Example",
      email: "ada@example.invalid",
      twoFactorEnabled: factor.enrolled,
      // Signed in a moment ago with a password: never enough on its own.
      sessionCreatedAt: ago(5),
      lastActiveAt: ago(5),
    },
    memberships: [],
    effective: {
      permissions: new Set([permission]),
      scopes: new Map(),
      roleKeys: [],
      session: "staff",
    },
    context: { tenantId: DEMO.tenantId, userId: null, scope: "none", locationIds: [] },
    required: [],
    mfaSatisfied: factor.usedAt !== null,
    mfaEnrolled: factor.enrolled,
    stepUpAt: factor.usedAt,
    stepUpWindowSeconds: WINDOW,
    deviceId: null,
    ip: null,
  };
}

describe("hazard HZ-112 every step-up permission counts from the second factor, not the sign-in", () => {
  it("covers every step-up permission in the catalogue", () => {
    expect(STEP_UP).toEqual(
      expect.arrayContaining([
        "people.person.break_glass",
        "medicines.cd.administer",
        "platform.export.create",
        "safety.notification.submit",
        "quality.evidence_pack.release",
        "finance.ledger.approve",
      ]),
    );
  });

  const cases = [
    {
      name: "a password-only sign-in just now, factor enrolled",
      factor: { enrolled: true, usedAt: null },
      expected: (p: Permission) =>
        touchesCareRecords(p) ? "mfa_verification_required" : "step_up_required",
      fresh: false,
    },
    {
      name: "a factor used within the window",
      factor: { enrolled: true, usedAt: ago(WINDOW - 60) },
      expected: () => null,
      fresh: true,
    },
    {
      name: "a factor used outside the window, signed in just now",
      factor: { enrolled: true, usedAt: ago(WINDOW + 60) },
      expected: () => "step_up_required",
      fresh: false,
    },
    {
      name: "no factor enrolled",
      factor: { enrolled: false, usedAt: null },
      expected: () => "mfa_enrolment_required",
      fresh: false,
    },
  ] as const;

  for (const permission of STEP_UP) {
    for (const c of cases) {
      it(`${permission}: ${c.name}`, () => {
        const access = accessWith(permission, c.factor);
        expect(refusalOf(access, permission, NOW)).toBe(c.expected(permission));
        expect(stepUpFresh(access, NOW)).toBe(c.fresh);
      });
    }
  }

  it("never reads the sign-in time for step-up in the API sources", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    for (const dir of ["routes", "services", "http", "auth"]) {
      for (const file of readdirSync(join(src, dir)).filter((f) => f.endsWith(".ts"))) {
        const text = readFileSync(join(src, dir, file), "utf8");
        const uses = text.split("\n").filter((l) => l.includes("sessionCreatedAt."));
        if (uses.length > 0) offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

let h: Harness;
const auth = () => h.db.pool("harbour_auth");
const code = async (r: Response) => ((await r.json()) as ProblemDetails).code;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

/**
 * A new session for a harness member, signed in just now. `factorAgo` adds a record of a second
 * factor used that many seconds ago; without it the session used a password only.
 */
async function signedIn(who: string, factorAgo?: number): Promise<string> {
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, "");
  await auth().query(
    `INSERT INTO auth.session (id, token, user_id, expires_at, created_at, updated_at)
     SELECT $1, $2, user_id, now() + interval '1 day', now(), now() FROM auth.session WHERE token = $3`,
    [id, token, h.tokens[who]?.split(".")[0]],
  );
  if (factorAgo !== undefined) {
    await auth().query(
      `INSERT INTO auth.verification (id, identifier, value, expires_at, created_at)
       VALUES (gen_random_uuid()::text, $1, 'totp', now() + interval '1 day',
               now() - make_interval(secs => $2))`,
      [factorIdentifier(id), factorAgo],
    );
  }
  return token;
}

interface StepUpRoute {
  readonly name: string;
  readonly who: string;
  readonly path: string;
  readonly body?: unknown;
  readonly operator?: boolean;
}

/** Every route family that needs step-up and is reachable over HTTP today. */
const ROUTES: readonly StepUpRoute[] = [
  {
    name: "break-glass",
    who: "manager",
    path: "/v1/people/break-glass",
    body: { personId: LODGE.personId, justification: "Covering an emergency at the lodge tonight" },
  },
  {
    name: "statutory notification submit",
    who: "manager",
    path: `/v1/notifications/statutory/${randomUUID()}/submit`,
    body: {
      submittedAt: new Date().toISOString(),
      externalReference: "CQC-0001-EXAMPLE",
      version: 1,
    },
  },
  {
    name: "downtime whole-home pack",
    who: "owner",
    path: `/v1/locations/${DEMO.locationId}/downtime-pack`,
  },
  {
    name: "invitation send",
    who: "manager",
    path: "/v1/invitations",
    body: { tenantUserId: randomUUID() },
  },
  {
    name: "member session revoke",
    who: "manager",
    path: `/v1/members/${randomUUID()}/sessions/revoke`,
    body: { reasonCode: "lost_or_stolen_device" },
  },
  {
    name: "operator owner invitation",
    who: "opsAdmin",
    path: `/operator/tenants/${randomUUID()}/owner-invitation`,
    operator: true,
  },
];

const post = (route: StepUpRoute, token: string) =>
  h.request(route.path, {
    method: "POST",
    token,
    ...(route.operator ? {} : { tenant: DEMO.tenantId }),
    ...(route.body === undefined ? {} : { body: route.body }),
  });

describe("hazard HZ-112 step-up routes need a second factor used within the window", () => {
  for (const route of ROUTES) {
    it(`${route.name}: a password-only sign-in just now is refused`, async () => {
      const refused = await post(route, await signedIn(route.who));
      expect(refused.status).toBe(403);
      // Care-record routes ask for the factor before the step-up; either way, use the factor.
      expect(["step_up_required", "mfa_verification_required"]).toContain(await code(refused));
    });

    it(`${route.name}: a factor used outside the window is refused, however recent the sign-in`, async () => {
      const refused = await post(route, await signedIn(route.who, WINDOW + 60));
      expect(refused.status).toBe(403);
      expect(await code(refused)).toBe("step_up_required");
    });

    it(`${route.name}: a factor used within the window passes the step-up`, async () => {
      const passed = await post(route, await signedIn(route.who, WINDOW - 60));
      if (passed.status === 403) expect(await code(passed)).not.toBe("step_up_required");
      expect(passed.status).not.toBe(401);
    });
  }
});

describe("hazard HZ-112 confirming a code on the session refreshes the step-up", () => {
  it("steps up again after an in-session authenticator code", async () => {
    const token = h.tokens.manager ?? "";
    const raw = token.split(".")[0] ?? "";
    const authCall = (path: string, body: unknown) =>
      h.request(path, { method: "POST", token, origin: MOBILE_APP_ORIGIN, body });
    const enable = await authCall("/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status).toBe(200);
    const uri = ((await enable.json()) as { totpURI: string }).totpURI;

    const route = ROUTES.find((r) => r.name === "member session revoke");
    if (!route) throw new Error("no revoke route");
    const revoke = (bearer: string) => post(route, bearer);
    await ageSession(auth(), raw, WINDOW + 60);
    const stale = await revoke(token);
    expect(stale.status).toBe(403);
    expect(await code(stale)).toBe("step_up_required");

    const verify = await authCall("/api/auth/two-factor/verify-totp", { code: totp(uri) });
    expect(verify.status).toBe(200);
    const current = verify.headers.get("set-auth-token") ?? token;
    const fresh = await revoke(current);
    if (fresh.status === 403) expect(await code(fresh)).not.toBe("step_up_required");
  });
});

/** RFC 6238 with Better Auth's defaults (SHA-1, 6 digits, 30 seconds), from an otpauth URI. */
function totp(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
