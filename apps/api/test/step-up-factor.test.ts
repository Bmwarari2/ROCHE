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
import { refusalOf, stepUpFresh, type TenantAccess, usablePermissions } from "../src/http/context";
import { ageSession, createHarness, type Harness, LODGE, PASSWORD } from "./support/harness";

/**
 * Hazard HZ-112 (ADR-0072 amendment): step-up needs a second factor (a passkey, an authenticator
 * code or a backup code) used on this session within `STEP_UP_WINDOW_SECONDS`. A password sign-in,
 * however recent, never counts; a member with no factor enrolled is asked to set one up.
 */

const WINDOW = 600;
const NOW = new Date("2026-10-16T09:00:00Z");
const STEP_UP = ALL_PERMISSIONS.filter(requiresStepUp);

interface FactorCase {
  /** A passkey or authenticator app is set up. */
  readonly enrolled: boolean;
  /** This session signed in or confirmed with a factor. */
  readonly used: boolean;
  /** The database judged that use within the window. */
  readonly fresh: boolean;
  /** The member's roles need MFA for care records (`tenant_user.mfa_required`). */
  readonly mfaRequired: boolean;
}

/** A member holding just `permission`, as the tenant middleware would build them. */
function accessWith(permission: Permission, factor: FactorCase): TenantAccess {
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
      sessionCreatedAt: NOW,
      lastActiveAt: NOW,
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
    mfaSatisfied: !factor.mfaRequired || factor.used,
    mfaEnrolled: factor.enrolled,
    stepUpFresh: factor.fresh,
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

  const cases: readonly {
    readonly name: string;
    readonly factor: FactorCase;
    readonly expected: (p: Permission) => string | null;
  }[] = [
    {
      name: "a password-only sign-in just now, factor enrolled",
      factor: { enrolled: true, used: false, fresh: false, mfaRequired: true },
      expected: (p) => (touchesCareRecords(p) ? "mfa_verification_required" : "step_up_required"),
    },
    {
      name: "a password-only sign-in just now, factor enrolled, MFA not required by role",
      factor: { enrolled: true, used: false, fresh: false, mfaRequired: false },
      expected: () => "step_up_required",
    },
    {
      name: "a factor used within the window",
      factor: { enrolled: true, used: true, fresh: true, mfaRequired: true },
      expected: () => null,
    },
    {
      name: "a factor used outside the window, signed in just now",
      factor: { enrolled: true, used: true, fresh: false, mfaRequired: true },
      expected: () => "step_up_required",
    },
    {
      name: "no factor enrolled, MFA required by role",
      factor: { enrolled: false, used: false, fresh: false, mfaRequired: true },
      expected: () => "mfa_enrolment_required",
    },
    {
      // MFA is met for care records here, so only the step-up rule can refuse (every permission,
      // care record or not, reaches it).
      name: "no factor enrolled, MFA not required by role",
      factor: { enrolled: false, used: false, fresh: false, mfaRequired: false },
      expected: () => "mfa_enrolment_required",
    },
  ];

  for (const permission of STEP_UP) {
    for (const c of cases) {
      it(`${permission}: ${c.name}`, () => {
        const access = accessWith(permission, c.factor);
        expect(refusalOf(access, permission, NOW)).toBe(c.expected(permission));
        expect(stepUpFresh(access)).toBe(c.factor.fresh);
        // A held step-up permission stays usable for the domain's checks, which then refuse it
        // with the factor rule, unless the care-record MFA rule refuses it first.
        const usable = usablePermissions(access, NOW).has(permission);
        expect(usable).toBe(access.mfaSatisfied || !touchesCareRecords(permission));
      });
    }
  }

  it("never gives a step-up check a sign-in time, in the API or the domain", () => {
    const offenders: string[] = [];
    let calls = 0;
    const roots = [
      fileURLToPath(new URL("../src", import.meta.url)),
      fileURLToPath(new URL("../../../packages/domain/src", import.meta.url)),
    ];
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? files(join(dir, e.name))
          : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
            ? [join(dir, e.name)]
            : [],
      );
    for (const file of roots.flatMap(files)) {
      const text = readFileSync(file, "utf8");
      if (/sessionCreatedAt\.|SignInAt|lastStrongAuth/.test(text)) offenders.push(file);
      // The third argument of every `authorise` call is the step-up time.
      for (const m of text.matchAll(/\bauthorise\(\s*[^,()]+,\s*[^,()]+,\s*([^,]+),/g)) {
        calls += 1;
        if (!/stepUpAt/.test(m[1] ?? "")) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
    // The API's check and the export, DPIA, sub-processor and break-glass search checks.
    expect(calls).toBeGreaterThanOrEqual(7);
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
  readonly method?: "POST" | "PUT";
  /** The body, built when sent (some carry a record's current version). */
  readonly body?: () => Promise<unknown> | unknown;
  readonly operator?: boolean;
  /** The status once the step-up is met: the route's own answer about the made-up record. */
  readonly passes: number;
}

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const LEAVER = resident(2);
const exitPath = `/v1/people/${LEAVER}/exit`;
const moneyVersion = async () => {
  const view = (await (await member("manager", exitPath)).json()) as {
    exit?: { checklist: { key: string; version: number }[] };
  };
  return view.exit?.checklist.find((i) => i.key === "residents_money_returned")?.version;
};
const member = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });

/** Every route family that needs step-up and is reachable over HTTP today. */
const ROUTES: readonly StepUpRoute[] = [
  {
    name: "break-glass",
    who: "manager",
    path: "/v1/people/break-glass",
    body: () => ({
      personId: LODGE.personId,
      justification: "Covering an emergency at the lodge tonight",
    }),
    passes: 201,
  },
  {
    name: "statutory notification submit",
    who: "manager",
    path: `/v1/notifications/statutory/${randomUUID()}/submit`,
    body: () => ({
      submittedAt: new Date().toISOString(),
      externalReference: "CQC-0001-EXAMPLE",
      version: 1,
    }),
    passes: 404,
  },
  {
    name: "downtime whole-home pack",
    who: "owner",
    path: `/v1/locations/${DEMO.locationId}/downtime-pack`,
    passes: 201,
  },
  {
    name: "invitation send",
    who: "manager",
    path: "/v1/invitations",
    body: () => ({ tenantUserId: randomUUID() }),
    passes: 404,
  },
  {
    name: "member session revoke",
    who: "manager",
    path: `/v1/members/${randomUUID()}/sessions/revoke`,
    body: () => ({ reasonCode: "lost_or_stolen_device" }),
    passes: 404,
  },
  {
    name: "About me share link",
    who: "manager",
    path: `/v1/people/${randomUUID()}/about-me/links`,
    body: () => ({
      sharingDecisionId: randomUUID(),
      expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    }),
    passes: 404,
  },
  {
    // Residents' money returned at exit: finance.ledger.approve, by someone other than the
    // manager who recorded the exit (people.md rule 12).
    name: "people exit, residents' money returned",
    who: "owner",
    method: "PUT",
    path: `${exitPath}/items/residents_money_returned`,
    body: async () => ({ status: "done", version: await moneyVersion() }),
    passes: 200,
  },
  {
    name: "operator owner invitation",
    who: "opsAdmin",
    path: `/operator/tenants/${randomUUID()}/owner-invitation`,
    operator: true,
    passes: 404,
  },
];

const send = async (route: StepUpRoute, token: string) => {
  const body = route.body ? await route.body() : undefined;
  return h.request(route.path, {
    method: route.method ?? "POST",
    token,
    ...(route.operator ? {} : { tenant: DEMO.tenantId }),
    ...(body === undefined ? {} : { body }),
  });
};

describe("hazard HZ-112 step-up routes need a second factor used within the window", () => {
  beforeAll(async () => {
    const planned = await member("manager", exitPath, {
      method: "POST",
      body: { kind: "discharge", details: { holdsResidentsMoney: true } },
    });
    expect(planned.status).toBe(201);
  });

  for (const route of ROUTES) {
    it(`${route.name}: a password-only sign-in just now is refused`, async () => {
      const refused = await send(route, await signedIn(route.who));
      expect(refused.status).toBe(403);
      // Care-record routes ask for the factor before the step-up; either way, use the factor.
      expect(["step_up_required", "mfa_verification_required"]).toContain(await code(refused));
    });

    it(`${route.name}: a factor used outside the window is refused, however recent the sign-in`, async () => {
      const refused = await send(route, await signedIn(route.who, WINDOW + 60));
      expect(refused.status).toBe(403);
      expect(await code(refused)).toBe("step_up_required");
    });

    it(`${route.name}: a factor used within the window passes the step-up`, async () => {
      const passed = await send(route, await signedIn(route.who, WINDOW - 60));
      expect(passed.status).toBe(route.passes);
    });
  }
});

describe("hazard HZ-112 a member with no factor enrolled is asked to set one up", () => {
  it("refuses step-up with mfa_enrolment_required, care record or not", async () => {
    await auth().query("UPDATE auth.user SET two_factor_enabled = false WHERE id = $1", [
      h.authIds.manager,
    ]);
    try {
      for (const name of ["member session revoke", "invitation send", "break-glass"]) {
        const route = ROUTES.find((r) => r.name === name);
        if (!route) throw new Error(name);
        // Even a session with a factor record left over does not step up without an enrolment.
        const refused = await send(route, await signedIn(route.who, 0));
        expect(refused.status).toBe(403);
        expect(await code(refused)).toBe("mfa_enrolment_required");
      }
    } finally {
      await auth().query("UPDATE auth.user SET two_factor_enabled = true WHERE id = $1", [
        h.authIds.manager,
      ]);
    }
  });
});

describe("hazard HZ-112 a task link counts a step-up permission only with a fresh factor", () => {
  async function stepUpTask(): Promise<string> {
    const created = await member("manager", "/v1/tasks", {
      method: "POST",
      body: { title: "Check the record", personId: resident(1), dueAt: new Date().toISOString() },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [DEMO.tenantId],
      );
      const updated = await client.query(
        `UPDATE task SET required_permission = 'safety.notification.submit',
                assignee_tenant_user_id = NULL, assignee_role_key = NULL WHERE id = $1`,
        [id],
      );
      expect(updated.rowCount).toBe(1);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    return id;
  }
  const taskStatus = async (id: string) => {
    const response = await member("manager", `/v1/tasks?personId=${resident(1)}&status=closed`);
    expect(response.status).toBe(200);
    const list = (await response.json()) as { items: { id: string; status: string }[] };
    return list.items.find((t) => t.id === id)?.status ?? "open";
  };
  const observe = (token: string, taskId: string) =>
    h.request(`/v1/people/${resident(1)}/observations`, {
      method: "POST",
      token,
      tenant: DEMO.tenantId,
      body: {
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
        values: { chart: "weight", kg: 60, method: "chair" },
        taskId,
      },
    });

  it("leaves the task open for a factor outside the window, and completes it within", async () => {
    const stale = await stepUpTask();
    expect((await observe(await signedIn("manager", WINDOW + 60), stale)).status).toBe(201);
    expect(await taskStatus(stale)).not.toBe("done");
    const fresh = await stepUpTask();
    expect((await observe(await signedIn("manager", WINDOW - 60), fresh)).status).toBe(201);
    expect(await taskStatus(fresh)).toBe("done");
  });
});

describe("hazard HZ-112 confirming a code on the session refreshes the step-up", () => {
  const route = () => {
    const found = ROUTES.find((r) => r.name === "member session revoke");
    if (!found) throw new Error("no revoke route");
    return found;
  };
  const token = () => h.tokens.manager ?? "";
  const raw = () => token().split(".")[0] ?? "";
  const authCall = (path: string, body: unknown) =>
    h.request(path, { method: "POST", token: token(), origin: MOBILE_APP_ORIGIN, body });
  let uri = "";
  let backupCodes: string[] = [];

  beforeAll(async () => {
    // The manager already has a factor; this session used it, so it may add an authenticator.
    const enable = await authCall("/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status).toBe(200);
    const body = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    uri = body.totpURI;
    backupCodes = body.backupCodes;
  });

  it("an authenticator code on an enrolled session steps it up again", async () => {
    await ageSession(auth(), raw(), WINDOW + 60);
    const stale = await send(route(), token());
    expect(stale.status).toBe(403);
    expect(await code(stale)).toBe("step_up_required");
    const verify = await authCall("/api/auth/two-factor/verify-totp", { code: totp(uri) });
    expect(verify.status).toBe(200);
    expect((await send(route(), token())).status).toBe(404);
  });

  it("a backup code steps it up again", async () => {
    await ageSession(auth(), raw(), WINDOW + 60);
    expect(await code(await send(route(), token()))).toBe("step_up_required");
    const verify = await authCall("/api/auth/two-factor/verify-backup-code", {
      code: backupCodes[0],
    });
    expect(verify.status).toBe(200);
    expect((await send(route(), token())).status).toBe(404);
  });

  it("stays refused after five wrong codes, even with the right one", async () => {
    await ageSession(auth(), raw(), WINDOW + 60);
    const right = totp(uri);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await authCall("/api/auth/two-factor/verify-totp", { code: wrong })).status).toBe(
        401,
      );
    }
    expect((await authCall("/api/auth/two-factor/verify-totp", { code: right })).status).toBe(429);
    expect(await code(await send(route(), token()))).toBe("step_up_required");
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
