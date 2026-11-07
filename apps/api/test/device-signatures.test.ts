import { generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { cdDoseStatementText } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { createHarness, type Harness } from "./support/harness";

/**
 * A controlled drug given offline on one phone, signed by its recorder and its witness with their
 * own PIN-unlocked keys (ADR-0084; Phase 2 slice 70; HZ-116): the keys are enrolled online with a
 * step-up on a phone bound to each member; the API verifies both signatures when the dose arrives
 * and writes the register entry with a `device_factor` witness. Invented people and ids only.
 */

let h: Harness;
const competence = fixedCompetence();
// Ada lives where the carer witnesses controlled drugs.
const ADA = "0194d000-0000-7000-8600-000000000001";
const MORPHINE = "90000081000001109";
const TABLET = "428673006";
const DEVICE = "0194d000-0000-7000-8600-0000000000e7";
const json = async <T>(r: Response) => (await r.json()) as T;
const send = (
  user: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const onPhone = { "x-harbour-device": DEVICE };

async function asDemo<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return { publicKey: raw.toString("base64"), privateKey };
}

const keys = { manager: keyPair(), carer: keyPair() };
const keyIds: Record<string, string> = {};
let entryId = "";

beforeAll(async () => {
  h = await createHarness();
  (h.handle.services as { medicines: { competence: unknown } }).medicines.competence = competence;
  for (const u of ["manager", "carer"] as const) {
    competence.held.set(`${DEMO.tenantId}:${DEMO.users[u].id}`, "current");
  }
  entryId = randomUUID();
  await asDemo(async (c) => {
    await c.query(
      "INSERT INTO device_binding (device_id, tenant_user_id) VALUES ($1, $2), ($1, $3)",
      [DEVICE, DEMO.users.manager.id, DEMO.users.carer.id],
    );
    await c.query(
      `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
         route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
         source_reference, transcribed_by, transcribed_at, cd_schedule, prn_dose, prn_max_per_24h,
         indication)
       VALUES ($1, $2, $1, 1, 'transcribed', $3, 'Morphine sulfate 10mg tablets', '26643006', 'Oral',
         'when_required', NULL, 'Dr A Example', now() - interval '1 day', 'prescription',
         'Prescription', $4, now() - interval '1 day', '2',
         '{"kind":"amount","quantity":1,"unit":{"code":"428673006","name":"tablet"}}', 4,
         'Pain')`,
      [entryId, ADA, MORPHINE, DEMO.users.manager.id],
    );
  });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

/** A UUIDv7 carrying the time, as the phone makes its record ids. */
function uuidV7At(at: Date): string {
  const id = `${at.getTime().toString(16).padStart(12, "0")}7${randomUUID().replace(/-/g, "").slice(13)}`;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function signed(
  role: "recorder" | "witness",
  signer: "manager" | "carer",
  administrationId: string,
  quantity: number,
  at: Date,
  privateKey: KeyObject = keys[signer].privateKey,
  givenAt: Date = at,
) {
  const text = cdDoseStatementText({
    tenantId: DEMO.tenantId,
    deviceId: DEVICE,
    role,
    signerId: DEMO.users[signer].id,
    recorderId: DEMO.users.manager.id,
    personId: ADA,
    entryId,
    administrationId,
    movement: "administration",
    vmpId: MORPHINE,
    givenAt: givenAt.toISOString(),
    quantity,
    unitCode: TABLET,
    signedAt: at.toISOString(),
  });
  return {
    keyId: keyIds[signer] as string,
    signature: sign("sha256", Buffer.from(text), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64"),
    signedAt: at.toISOString(),
  };
}

const dose = (id: string, at: Date, controlledDrug: unknown, quantity = 1) =>
  send("manager", `/v1/people/${ADA}/medicine-administrations`, {
    method: "POST",
    headers: onPhone,
    body: {
      id,
      entryId,
      outcome: "given",
      amount: { quantity, unitCode: TABLET },
      givenAt: at.toISOString(),
      deviceRecordedAt: at.toISOString(),
      pointOfCare: {
        identity: "photo",
        pack: { method: "override", override: { code: "no_barcode_on_pack", note: null } },
      },
      controlledDrug,
    },
  });

describe("hazard HZ-116 a controlled drug witnessed on one phone offline (ADR-0084)", () => {
  it("enrols each member's key for the phone, only on a phone bound to them", async () => {
    for (const who of ["manager", "carer"] as const) {
      const r = await send(who, "/v1/me/device-keys", {
        method: "POST",
        headers: onPhone,
        body: { publicKey: keys[who].publicKey },
      });
      expect(r.status, await r.clone().text()).toBe(201);
      keyIds[who] = (await json<{ id: string }>(r)).id;
    }
  });

  it("opens the page and takes a witnessed receipt, online, as the register does", async () => {
    const opened = await send("manager", `/v1/people/${ADA}/controlled-drugs/pages`, {
      method: "POST",
      body: { entryId },
    });
    expect(opened.status, await opened.clone().text()).toBeLessThan(300);
    const pageId = (await json<{ id: string }>(opened)).id;
    const asserted = await send(
      "carer",
      `/v1/controlled-drugs/pages/${pageId}/witness-assertions`,
      {
        method: "POST",
        body: { movement: "receipt", quantity: 28, recorderId: DEMO.users.manager.id },
      },
    );
    expect(asserted.status, await asserted.clone().text()).toBe(201);
    const receipt = await send("manager", `/v1/controlled-drugs/pages/${pageId}/entries`, {
      method: "POST",
      body: {
        movement: "receipt",
        quantity: 28,
        counterparty: "Example Pharmacy",
        reference: "Delivery note 1001",
        witness: { witnessAssertionId: (await json<{ id: string }>(asserted)).id },
      },
    });
    expect(receipt.status, await receipt.clone().text()).toBe(201);
  });

  it("records the dose with its register entry when both signatures stand", async () => {
    // After the keys were enrolled: a signature older than its key is refused.
    const at = new Date();
    const id = uuidV7At(at);
    const r = await dose(id, at, {
      deviceSignatures: {
        recorder: signed("recorder", "manager", id, 1, at),
        witness: {
          ...signed("witness", "carer", id, 1, new Date(at.getTime() - 200), undefined, at),
          witnessId: DEMO.users.carer.id,
        },
      },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const row = await asDemo(
      async (c) =>
        (
          await c.query<{ method: string; used: boolean }>(
            `SELECT a.method, a.used_at IS NOT NULL AS used FROM controlled_drug_witness_assertion a
              WHERE a.administration_id = $1`,
            [id],
          )
        ).rows[0],
    );
    expect(row).toEqual({ method: "device_factor", used: true });
  });

  it.each([
    ["a signature over another amount", "recorder_signature_invalid", "amount"],
    ["the recorder witnessing themselves", "witness_key_not_for_signer", "self"],
    ["a witness key from another member", "witness_key_not_for_signer", "wrong_key"],
  ] as const)("refuses %s", async (_case, code, kind) => {
    const at = new Date();
    const id = uuidV7At(at);
    const recorder = signed("recorder", "manager", id, kind === "amount" ? 2 : 1, at);
    const witness =
      kind === "self"
        ? {
            ...signed("witness", "manager", id, 1, at),
            keyId: keyIds.carer as string,
            witnessId: DEMO.users.manager.id,
          }
        : kind === "wrong_key"
          ? {
              ...signed("witness", "carer", id, 1, at),
              keyId: keyIds.manager as string,
              witnessId: DEMO.users.carer.id,
            }
          : { ...signed("witness", "carer", id, 1, at), witnessId: DEMO.users.carer.id };
    const r = await dose(id, at, { deviceSignatures: { recorder, witness } });
    expect(r.status).toBe(422);
    expect((await json<{ code: string }>(r)).code).toBe(`administration_${code}`);
  });

  it("refuses a witness who signed after the dose was recorded", async () => {
    const at = new Date();
    const id = uuidV7At(at);
    const r = await dose(id, at, {
      deviceSignatures: {
        recorder: signed("recorder", "manager", id, 1, at),
        witness: {
          ...signed("witness", "carer", id, 1, new Date(at.getTime() + 200), undefined, at),
          witnessId: DEMO.users.carer.id,
        },
      },
    });
    expect((await json<{ code: string }>(r)).code).toBe("administration_pair_witness_signed_after");
  });

  it("hazard HZ-116 takes the recorder's signature with why there was no witness only where the policy allows", async () => {
    const at = new Date();
    const id = uuidV7At(at);
    const r = await dose(id, at, {
      deviceSignatures: {
        recorder: signed("recorder", "manager", id, 1, at),
        noWitnessReason: "Working alone at the person's home",
      },
    });
    // The demo home is residential: its policy requires a witness, so the register refuses it.
    expect(r.status).toBe(422);
    expect((await json<{ code: string }>(r)).code).not.toMatch(/signature/);
  });

  it("refuses signatures made on a phone that are sent without it", async () => {
    const at = new Date();
    const id = uuidV7At(at);
    const r = await send("manager", `/v1/people/${ADA}/medicine-administrations`, {
      method: "POST",
      body: {
        id,
        entryId,
        outcome: "given",
        amount: { quantity: 1, unitCode: TABLET },
        controlledDrug: {
          deviceSignatures: {
            recorder: signed("recorder", "manager", id, 1, at),
            witness: { ...signed("witness", "carer", id, 1, at), witnessId: DEMO.users.carer.id },
          },
        },
      },
    });
    expect((await json<{ code: string }>(r)).code).toBe(
      "administration_device_signatures_from_device",
    );
  });

  it("hazard HZ-115 keeps a copy of a dose the API refused, with an urgent review, never only on the phone", async () => {
    const at = new Date();
    const id = uuidV7At(at);
    const r = await send("manager", "/v1/sync/refused-entries", {
      method: "POST",
      headers: onPhone,
      body: {
        entryId: id,
        table: "medication_administration",
        personId: ADA,
        httpStatus: 422,
        code: "administration_witness_key_replaced",
        message: "A signature was made with a PIN that had been replaced on this phone.",
        refusedAt: at.toISOString(),
        payload: {
          kind: "record",
          body: {
            id,
            entryId,
            outcome: "given",
            amount: { quantity: 1, unitCode: TABLET },
            givenAt: at.toISOString(),
          },
        },
      },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await json<{ taskId: string | null }>(r)).taskId).not.toBeNull();
  });

  // Last: revoking a phone also ends the sessions bound to it.
  it("takes no new key on a phone whose access was withdrawn", async () => {
    // A phone whose access was withdrawn takes no new key.
    const revoked = randomUUID();
    const first = await send("manager", "/v1/me/device-keys", {
      method: "POST",
      headers: { "x-harbour-device": revoked },
      body: { publicKey: keys.manager.publicKey },
    });
    expect(first.status).toBe(201);
    await asDemo((c) =>
      c.query(
        `UPDATE device_binding SET revoked_at = now(), revoked_by = $2, revocation_reason = 'lost_or_stolen'
          WHERE device_id = $1`,
        [revoked, DEMO.users.owner.id],
      ),
    );
    const again = await send("manager", "/v1/me/device-keys", {
      method: "POST",
      headers: { "x-harbour-device": revoked },
      body: { publicKey: keys.manager.publicKey },
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });
});
