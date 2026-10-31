import { DEMO } from "@harbour/db/seed";
import { addUkDays, ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageSession, createHarness, type Harness } from "./support/harness";

/**
 * Identity and vetting adapters through the API (workforce.md section 2e and rule 24; WORK-002;
 * ADR-0094; plan slice 77): every port off by default; switching one on needs a known provider and
 * a fresh step-up; each route's permission and audited refusals; consent for the DBS checks; the
 * NMC, IDSP, DBS e-bulk and Update Service journeys through the mock to an item applied with its
 * source, date and checker; outcomes that are never applied; a result for a replaced certificate;
 * manual entry setting the source back to manual; switching a port off.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const FILES = "/v1/workforce/staff-files";
const today = () => ukIsoDate(new Date());
const inDays = (days: number) => ukIsoDate(addUkDays(new Date(), days));

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } finally {
    client.release();
  }
}

interface Check {
  id: string;
  version: number;
  kind: string;
  state: string;
  result: Record<string, unknown> | null;
  error: string | null;
  applicable: boolean;
  notApplicableReason: string | null;
  appliedBy: { id: string } | null;
  checked: Record<string, string>;
}
interface Vetting {
  consents: { id: string; version: number; purpose: string; inForce: boolean }[];
  checks: Check[];
  ports: { port: string; on: boolean; provider: string | null }[];
}
interface Item {
  kind: string;
  id: string | null;
  version: number | null;
  status: string;
  detail: Record<string, unknown> | null;
  verifiedOn: string | null;
  verifiedBy: { id: string } | null;
  evidenceSource: string;
  vettingCheckId: string | null;
}

let fileId = "";
const vetting = async (who = "manager") =>
  (await (await as(who, `${FILES}/${fileId}/vetting`)).json()) as Vetting;
const itemOf = async (kind: string) => {
  const file = (await (await as("manager", `${FILES}/${fileId}`)).json()) as { items: Item[] };
  const found = file.items.find((i) => i.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
};
const switchOn = (port: string, settings: Record<string, string> = {}, provider = "mock") =>
  as("owner", `/v1/integrations/${port}`, { method: "PUT", body: { provider, settings } });
const start = (body: Record<string, unknown>, who = "manager") =>
  as(who, `${FILES}/${fileId}/vetting/checks`, { method: "POST", body });
const latest = (v: Vetting, kind: string) => {
  const found = v.checks.find((c) => c.kind === kind);
  if (!found) throw new Error(`no ${kind} check`);
  return found;
};
const apply = async (check: Check, kind: string, extra: Record<string, unknown> = {}) => {
  const item = await itemOf(kind);
  return as("manager", `${FILES}/${fileId}/vetting/checks/${check.id}/apply`, {
    method: "POST",
    body: { expectedVersion: check.version, itemExpectedVersion: item.version, ...extra },
  });
};
const record = async (kind: string, detail: Record<string, unknown>) => {
  const item = await itemOf(kind);
  return as("manager", `${FILES}/${fileId}/items/${kind}`, {
    method: "PUT",
    body: {
      ...(item.version ? { expectedVersion: item.version } : {}),
      detail,
      verifiedOn: today(),
    },
  });
};
const code = async (response: Response) => ((await response.json()) as { code: string }).code;
const audited = async (action: string, outcome: string) =>
  Number(
    (
      await sql<{ n: string }>(
        "SELECT count(*) AS n FROM audit_event WHERE action = $1 AND outcome = $2",
        [action, outcome],
      )
    )[0]?.n,
  );

beforeAll(async () => {
  h = await createHarness();
  const created = await as("manager", FILES, {
    method: "POST",
    body: {
      tenantUserId: DEMO.users.carer.id,
      locationId: DEMO.locationId,
      jobTitle: "Registered nurse",
      pathwayCategory: null,
      registrationBody: "nmc",
      previousCareWork: false,
      dateOfBirth: "1990-04-01",
      startsOn: "2026-09-01",
      leftOn: null,
    },
  });
  expect(created.status).toBe(201);
  fileId = ((await created.json()) as { id: string }).id;
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe("ports are off by default (ADR-0094)", () => {
  it("lists every port off, and a check is refused until one is switched on", async () => {
    const ports = await as("manager", "/v1/workforce/vetting/ports");
    expect(ports.status).toBe(200);
    const body = (await ports.json()) as { items: { port: string; on: boolean }[] };
    expect(body.items.map((p) => p.port).sort()).toEqual([
      "workforce.dbs_ebulk",
      "workforce.dbs_update_service",
      "workforce.idsp",
      "workforce.nmc_register",
    ]);
    expect(body.items.every((p) => !p.on)).toBe(true);
    const refused = await start({ kind: "nmc_register_check" });
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe("adapter_off");
    expect(await audited("workforce.vetting_check.started", "denied")).toBeGreaterThanOrEqual(1);
  });

  it("switches on only with a known provider, by a holder of integrations.connection.manage", async () => {
    expect((await switchOn("workforce.nmc_register", {}, "acme")).status).toBe(422);
    expect(
      (
        await as("carer", "/v1/integrations/workforce.nmc_register", {
          method: "PUT",
          body: { provider: "mock", settings: {} },
        })
      ).status,
    ).toBe(403);
    expect((await switchOn("workforce.nmc_register")).status).toBe(204);
    const ports = (await (await as("manager", "/v1/workforce/vetting/ports")).json()) as {
      items: { port: string; on: boolean; provider: string | null }[];
    };
    expect(ports.items.find((p) => p.port === "workforce.nmc_register")).toEqual({
      port: "workforce.nmc_register",
      on: true,
      provider: "mock",
    });
  });
});

describe("permissions", () => {
  it("the worker and readers without the staff file permissions see and start nothing", async () => {
    expect((await as("carer", `${FILES}/${fileId}/vetting`)).status).toBe(403);
    expect((await as("nurse", `${FILES}/${fileId}/vetting`)).status).toBe(403);
    expect((await start({ kind: "nmc_register_check" }, "carer")).status).toBe(403);
    expect((await as("carer", "/v1/workforce/vetting/ports")).status).toBe(403);
  });
});

describe("the NMC register (H-523: the manual check stays the default)", () => {
  it("needs a PIN on the file", async () => {
    const refused = await start({ kind: "nmc_register_check" });
    expect(refused.status).toBe(422);
    expect(await code(refused)).toBe("no_pin");
  });

  it("applies a registration with its source, date and checker", async () => {
    expect(
      (
        await record("professional_registration", {
          kind: "professional_registration",
          body: "nmc",
          pin: "99A9999E",
          renewalDueOn: inDays(20),
          revalidationDueOn: null,
        })
      ).status,
    ).toBe(200);
    expect((await itemOf("professional_registration")).evidenceSource).toBe("manual");
    const started = await start({ kind: "nmc_register_check" });
    expect(started.status).toBe(201);
    const check = latest((await started.json()) as Vetting, "nmc_register_check");
    expect(check).toMatchObject({
      state: "completed",
      applicable: true,
      checked: { pin: "99A9999E" },
      result: { outcome: "registered", checkedOn: today() },
    });
    const applied = await apply(check, "professional_registration");
    expect(applied.status).toBe(200);
    const item = await itemOf("professional_registration");
    expect(item).toMatchObject({
      evidenceSource: "nmc_register_check",
      vettingCheckId: check.id,
      verifiedOn: today(),
      verifiedBy: { id: DEMO.users.manager.id },
    });
    expect(item.detail?.renewalDueOn).toBe(check.result?.renewalDueOn);
    const again = await apply(
      latest(await vetting(), "nmc_register_check"),
      "professional_registration",
    );
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("already_applied");
    expect(await audited("workforce.vetting_check.applied", "success")).toBe(1);
  });

  it("never applies a PIN not on the register", async () => {
    expect((await switchOn("workforce.nmc_register", { scenario: "not_registered" })).status).toBe(
      204,
    );
    const started = await start({ kind: "nmc_register_check" });
    const check = latest((await started.json()) as Vetting, "nmc_register_check");
    expect(check).toMatchObject({ applicable: false, notApplicableReason: "not_registered" });
    const before = await itemOf("professional_registration");
    const refused = await apply(check, "professional_registration");
    expect(refused.status).toBe(422);
    expect(await code(refused)).toBe("not_registered");
    expect((await itemOf("professional_registration")).version).toBe(before.version);
  });

  it("recording by hand sets the source back to manual", async () => {
    const item = await itemOf("professional_registration");
    expect(
      (
        await record("professional_registration", {
          ...(item.detail as object),
          renewalDueOn: inDays(30),
        })
      ).status,
    ).toBe(200);
    expect(await itemOf("professional_registration")).toMatchObject({
      evidenceSource: "manual",
      vettingCheckId: null,
    });
  });
});

describe("an identity service provider (right to work)", () => {
  it("checks British and Irish passports only", async () => {
    expect((await switchOn("workforce.idsp")).status).toBe(204);
    const refused = await start({
      kind: "idsp_right_to_work",
      document: "biometric_residence_permit",
    });
    expect(refused.status).toBe(422);
  });

  it("is applied only once the checker confirms the photograph is of the worker", async () => {
    const started = await start({ kind: "idsp_right_to_work", document: "irish_passport" });
    expect(started.status).toBe(201);
    const check = latest((await started.json()) as Vetting, "idsp_right_to_work");
    expect(check.result).toMatchObject({
      outcome: "identity_verified",
      document: "irish_passport",
    });
    const unconfirmed = await apply(check, "right_to_work");
    expect(unconfirmed.status).toBe(422);
    expect(await code(unconfirmed)).toBe("identity_not_confirmed");
    expect((await apply(check, "right_to_work", { identityConfirmed: true })).status).toBe(200);
    const item = await itemOf("right_to_work");
    expect(item).toMatchObject({
      status: "satisfied",
      evidenceSource: "idsp_right_to_work",
      vettingCheckId: check.id,
      detail: {
        kind: "right_to_work",
        checks: [{ method: "idsp", checkedOn: today(), permission: "unlimited", expiresOn: null }],
      },
    });
  });
});

describe("DBS e-bulk applications (with the worker's consent)", () => {
  it("needs the worker's consent, recorded by HR, never by the worker", async () => {
    expect((await switchOn("workforce.dbs_ebulk")).status).toBe(204);
    const refused = await start({ kind: "dbs_application" });
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe("consent_missing");
    const consent = (body: Record<string, unknown>, who = "manager") =>
      as(who, `${FILES}/${fileId}/vetting/consents`, { method: "POST", body });
    expect((await consent({ purpose: "dbs_application", givenOn: today() }, "carer")).status).toBe(
      403,
    );
    expect((await consent({ purpose: "dbs_application", givenOn: inDays(1) })).status).toBe(422);
    expect((await consent({ purpose: "dbs_application", givenOn: today() })).status).toBe(201);
    const twice = await consent({ purpose: "dbs_application", givenOn: today() });
    expect(twice.status).toBe(409);
    expect(await code(twice)).toBe("consent_in_force");
  });

  it("is pending until the certificate is issued, then records the minimum only", async () => {
    const started = await start({ kind: "dbs_application" });
    expect(started.status).toBe(201);
    const pending = latest((await started.json()) as Vetting, "dbs_application");
    expect(pending.state).toBe("pending");
    const open = await start({ kind: "dbs_application" });
    expect(open.status).toBe(409);
    expect(await code(open)).toBe("check_open");
    const refreshed = await as(
      "manager",
      `${FILES}/${fileId}/vetting/checks/${pending.id}/refresh`,
      { method: "POST", body: { expectedVersion: pending.version } },
    );
    expect(refreshed.status).toBe(200);
    const done = latest((await refreshed.json()) as Vetting, "dbs_application");
    expect(done.state).toBe("completed");
    expect(Object.keys(done.result ?? {}).sort()).toEqual([
      "certificateNumber",
      "checkedOn",
      "issuedOn",
      "level",
      "outcome",
      "result",
    ]);
    expect((await apply(done, "dbs_certificate")).status).toBe(200);
    const item = await itemOf("dbs_certificate");
    expect(item).toMatchObject({
      evidenceSource: "dbs_application",
      detail: {
        certificate: {
          level: "enhanced_adults_barred",
          number: done.result?.certificateNumber,
          result: "clear",
        },
      },
    });
  });
});

describe("DBS Update Service status checks (with the worker's consent)", () => {
  it("needs consent to status checks, a subscribed certificate and the surname", async () => {
    expect((await switchOn("workforce.dbs_update_service")).status).toBe(204);
    const noConsent = await start({ kind: "dbs_status_check", familyName: "Example" });
    expect(await code(noConsent)).toBe("consent_missing");
    expect(
      (
        await as("manager", `${FILES}/${fileId}/vetting/consents`, {
          method: "POST",
          body: { purpose: "dbs_update_service", givenOn: today() },
        })
      ).status,
    ).toBe(201);
    const notSubscribed = await start({ kind: "dbs_status_check", familyName: "Example" });
    expect(notSubscribed.status).toBe(422);
    expect(await code(notSubscribed)).toBe("not_subscribed");
    expect((await start({ kind: "dbs_status_check" })).status).toBe(422);
  });

  it("is not applied once the certificate has been replaced", async () => {
    const item = await itemOf("dbs_certificate");
    const detail = item.detail as Record<string, unknown>;
    expect(
      (
        await record("dbs_certificate", {
          ...detail,
          updateService: { subscribed: true, lastCheckedOn: null, lastResult: null },
        })
      ).status,
    ).toBe(200);
    const started = await start({ kind: "dbs_status_check", familyName: "Example" });
    expect(started.status).toBe(201);
    const check = latest((await started.json()) as Vetting, "dbs_status_check");
    expect(check.result).toMatchObject({ outcome: "no_new_information" });
    const certificate = detail.certificate as Record<string, unknown>;
    expect(
      (
        await record("dbs_certificate", {
          ...detail,
          certificate: { ...certificate, number: "009999999990" },
          updateService: { subscribed: true, lastCheckedOn: null, lastResult: null },
        })
      ).status,
    ).toBe(200);
    const refused = await apply(check, "dbs_certificate");
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe("item_changed");
  });

  it("records the status check's date and result", async () => {
    const started = await start({ kind: "dbs_status_check", familyName: "Example" });
    const check = latest((await started.json()) as Vetting, "dbs_status_check");
    expect(check.checked).toEqual({ certificateNumber: "009999999990" });
    expect((await apply(check, "dbs_certificate")).status).toBe(200);
    expect(await itemOf("dbs_certificate")).toMatchObject({
      evidenceSource: "dbs_status_check",
      detail: {
        updateService: {
          subscribed: true,
          lastCheckedOn: today(),
          lastResult: "no_new_information",
        },
      },
    });
  });

  it("stops once the worker withdraws their consent", async () => {
    const consent = (await vetting()).consents.find(
      (c) => c.purpose === "dbs_update_service" && c.inForce,
    );
    if (!consent) throw new Error("no consent");
    const withdrawn = await as(
      "manager",
      `${FILES}/${fileId}/vetting/consents/${consent.id}/withdraw`,
      { method: "POST", body: { expectedVersion: consent.version, withdrawnOn: today() } },
    );
    expect(withdrawn.status).toBe(200);
    expect(((await withdrawn.json()) as { inForce: boolean }).inForce).toBe(false);
    const again = await as(
      "manager",
      `${FILES}/${fileId}/vetting/consents/${consent.id}/withdraw`,
      { method: "POST", body: { expectedVersion: consent.version + 1, withdrawnOn: today() } },
    );
    expect(await code(again)).toBe("already_withdrawn");
    const refused = await start({ kind: "dbs_status_check", familyName: "Example" });
    expect(await code(refused)).toBe("consent_missing");
    expect(await audited("workforce.vetting_consent.withdrawn", "success")).toBe(1);
  });
});

describe("switching a port off", () => {
  it("sends checks back to manual entry, keeping those already made", async () => {
    expect(
      (await as("owner", "/v1/integrations/workforce.nmc_register", { method: "DELETE" })).status,
    ).toBe(204);
    const refused = await start({ kind: "nmc_register_check" });
    expect(await code(refused)).toBe("adapter_off");
    expect((await vetting()).checks.filter((c) => c.kind === "nmc_register_check").length).toBe(2);
  });

  it("switching on or off needs a fresh step-up", async () => {
    await ageSession(h.db.pool("harbour_auth"), h.tokens.owner?.split(".")[0] ?? "", 3600);
    const refused = await switchOn("workforce.nmc_register");
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("step_up_required");
  });
});
