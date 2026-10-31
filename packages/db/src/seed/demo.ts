import { BUILTIN_ROLES } from "@harbour/domain";
import type pg from "pg";
import type { BankHolidaySeedRow, RateSeedRow, RetentionSeedRow } from "./reference-data";

/**
 * Seed data: global reference tables and the demo tenant used on dev and staging. Every person is
 * invented ("Ada Example"), every email is on example.invalid and every NHS number is in the 999
 * test range (master prompt section 20 rule 5). Fixed UUIDs make the seed idempotent and let
 * walkthroughs in docs/demo/ refer to records by id.
 */

export const DEMO = {
  tenantId: "0194d000-0000-7000-8000-000000000001",
  locationId: "0194d000-0000-7000-8000-000000000101",
  nursingServiceId: "0194d000-0000-7000-8000-000000000201",
  residentialServiceId: "0194d000-0000-7000-8000-000000000202",
  users: {
    owner: {
      id: "0194d000-0000-7000-8000-000000000301",
      email: "owner@example.invalid",
      name: "Olive Owner",
      role: "owner",
    },
    manager: {
      id: "0194d000-0000-7000-8000-000000000302",
      email: "manager@example.invalid",
      name: "Mo Manager",
      role: "registered_manager",
    },
    nurse: {
      id: "0194d000-0000-7000-8000-000000000303",
      email: "nurse@example.invalid",
      name: "Nell Nurse",
      role: "clinical_lead",
    },
    carer: {
      id: "0194d000-0000-7000-8000-000000000304",
      email: "carer@example.invalid",
      name: "Cat Carer",
      role: "care_worker",
    },
  },
} as const;

export type DemoUserKey = keyof typeof DEMO.users;

/** When the demo residents were admitted (their placements start on 1 September). */
export const DEMO_ADMITTED_AT = "2026-09-01T00:00:00+01:00";

interface DemoPerson {
  readonly n: number;
  readonly given: string;
  readonly family: string;
  readonly preferred: string | null;
  readonly dob: string;
  readonly nhs: string;
  readonly room: string;
  readonly allergyStatus: "unknown" | "no_known_allergies" | "has_allergies";
  readonly allergies: readonly { substance: string; severity: string; reaction: string | null }[];
  readonly communication: readonly { code: string; display: string; preferredFormat?: string }[];
}

const PEOPLE: readonly DemoPerson[] = [
  {
    n: 1,
    given: "Ada",
    family: "Example",
    preferred: "Addie",
    dob: "1938-02-01",
    nhs: "9990000018",
    room: "1",
    allergyStatus: "has_allergies",
    allergies: [{ substance: "Penicillin", severity: "severe", reaction: "Rash and swelling" }],
    communication: [
      {
        code: "demo:large-print",
        display: "Needs information in large print",
        preferredFormat: "Large print",
      },
    ],
  },
  {
    n: 2,
    given: "Ben",
    family: "Sample",
    preferred: null,
    dob: "1941-07-15",
    nhs: "9990000026",
    room: "2",
    allergyStatus: "no_known_allergies",
    allergies: [],
    communication: [],
  },
  {
    n: 3,
    given: "Cara",
    family: "Placeholder",
    preferred: null,
    dob: "1935-11-30",
    nhs: "9990000034",
    room: "3",
    allergyStatus: "unknown",
    allergies: [],
    communication: [{ code: "demo:hearing-loop", display: "Uses a hearing loop" }],
  },
  {
    n: 4,
    given: "Dev",
    family: "Fixture",
    preferred: null,
    dob: "1944-04-20",
    nhs: "9990000042",
    room: "4",
    allergyStatus: "has_allergies",
    allergies: [
      { substance: "Latex", severity: "moderate", reaction: null },
      { substance: "Peanut", severity: "severe", reaction: "Anaphylaxis" },
    ],
    communication: [],
  },
  {
    n: 5,
    given: "Elsie",
    family: "Mock",
    preferred: "Else",
    dob: "1930-09-09",
    nhs: "9990000050",
    room: "5",
    allergyStatus: "no_known_allergies",
    allergies: [],
    communication: [{ code: "demo:interpreter", display: "Needs a Welsh language interpreter" }],
  },
  {
    n: 6,
    given: "Frank",
    family: "Dummy",
    preferred: null,
    dob: "1946-01-25",
    nhs: "9990000069",
    room: "6",
    allergyStatus: "has_allergies",
    allergies: [{ substance: "Aspirin", severity: "mild", reaction: "Stomach upset" }],
    communication: [],
  },
];

const uuid = (prefix: string, n: number) =>
  `0194d000-0000-7000-8${prefix}-${n.toString(16).padStart(12, "0")}`;

async function inTenant<T>(
  client: pg.PoolClient,
  tenantId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenantId ?? ""],
    );
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Upserts the global (NULL tenant) statutory figures, the retention schedule and the bank holidays.
 * Runs as the owner.
 */
export async function seedReferenceData(
  ownerPool: pg.Pool,
  rates: readonly RateSeedRow[],
  retention: readonly RetentionSeedRow[],
  bankHolidays: readonly BankHolidaySeedRow[] = [],
): Promise<{ rates: number; retention: number; bankHolidays: number }> {
  const client = await ownerPool.connect();
  try {
    return await inTenant(client, null, async () => {
      // The documents are the source of truth: replace the global rows wholesale.
      await client.query("DELETE FROM rate_table WHERE tenant_id IS NULL");
      for (const r of rates) {
        await client.query(
          `INSERT INTO rate_table (key, value, unit, nation, valid_from, valid_to, source, verification_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            r.key,
            r.value,
            r.unit,
            r.nation,
            r.validFrom,
            r.validTo,
            r.source,
            r.verificationStatus,
          ],
        );
      }
      await client.query("DELETE FROM retention_class WHERE tenant_id IS NULL");
      for (const r of retention) {
        await client.query(
          `INSERT INTO retention_class (record_class, period, unit, trigger, source, notes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [r.recordClass, r.period, r.unit, r.trigger, r.source, r.notes],
        );
      }
      await client.query("DELETE FROM bank_holiday");
      for (const h of bankHolidays) {
        await client.query("INSERT INTO bank_holiday (nation, date, name) VALUES ($1, $2, $3)", [
          h.nation,
          h.date,
          h.name,
        ]);
      }
      return {
        rates: rates.length,
        retention: retention.length,
        bankHolidays: bankHolidays.length,
      };
    });
  } finally {
    client.release();
  }
}

/**
 * Feature flags switched on for the demo tenant only. Waterlow and Braden stay off by default for
 * real tenants until their licence terms are confirmed (human action H-25, care.md section 10).
 */
export const DEMO_FLAGS_ON = ["care.tool.waterlow", "care.tool.braden"] as const;

async function seedDemoFlags(client: pg.PoolClient): Promise<void> {
  for (const flagKey of DEMO_FLAGS_ON) {
    await client.query(
      "INSERT INTO feature_flag (flag_key, enabled) VALUES ($1, true) ON CONFLICT DO NOTHING",
      [flagKey],
    );
  }
}

/** The demo organisation's escalation policy for NEWS2 (care.md rule 5): a title and reference only. */
export const DEMO_ESCALATION_POLICY = {
  toolKey: "news2",
  title: "Deterioration and escalation policy",
  reference: "CP-07",
} as const;

/**
 * Links the demo organisation's escalation policy to NEWS2 results, so the demo shows a configured
 * policy on vital signs and "not configured" on the other tools (HZ-012, HZ-014). Kept out of
 * `seedDemoTenant`, which the API tests share, so their organisations start with no policy. Safe to
 * run repeatedly: one live link per tool, band and place.
 */
export async function seedDemoEscalationPolicies(ownerPool: pg.Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await inTenant(client, DEMO.tenantId, async () => {
      await client.query(
        `INSERT INTO escalation_policy_link (tool_key, band, location_id, title, reference)
         VALUES ($1, NULL, NULL, $2, $3) ON CONFLICT DO NOTHING`,
        [
          DEMO_ESCALATION_POLICY.toolKey,
          DEMO_ESCALATION_POLICY.title,
          DEMO_ESCALATION_POLICY.reference,
        ],
      );
    });
  } finally {
    client.release();
  }
}

/** Creates the demo tenant if it does not exist. Safe to run repeatedly. */
export async function seedDemoTenant(ownerPool: pg.Pool): Promise<{ created: boolean }> {
  const client = await ownerPool.connect();
  try {
    return await inTenant(client, DEMO.tenantId, async () => {
      const existing = await client.query("SELECT 1 FROM tenant WHERE id = $1", [DEMO.tenantId]);
      if ((existing.rowCount ?? 0) > 0) {
        await seedDemoFlags(client);
        return { created: false };
      }

      await client.query(
        `INSERT INTO tenant (id, name, legal_name, legal_form, status, nation, terminology, brand_name, cqc_provider_id)
         VALUES ($1, 'Harbour Demo Care', 'Harbour Demo Care Ltd', 'limited_company', 'active', 'england', 'resident', 'Harbour Demo Care', '1-DEMO000000')`,
        [DEMO.tenantId],
      );
      await client.query(
        `INSERT INTO location (id, name, regulator, regulator_location_id, ods_code, nation, town, postcode, bed_capacity)
         VALUES ($1, 'Harbour House', 'cqc', '1-DEMO000001', 'DEMO1', 'england', 'Exampleton', 'ZZ99 3ZZ', 60)`,
        [DEMO.locationId],
      );
      await client.query(
        `INSERT INTO service (id, location_id, name, service_type) VALUES
           ($1, $3, 'Harbour House nursing', 'nursing'),
           ($2, $3, 'Harbour House residential', 'residential')`,
        [DEMO.nursingServiceId, DEMO.residentialServiceId, DEMO.locationId],
      );
      await seedDemoFlags(client);
      for (let room = 1; room <= 60; room++) {
        await client.query(
          `INSERT INTO room (id, location_id, label, unit_name, floor, ensuite)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            uuid("400", room),
            DEMO.locationId,
            String(room),
            room <= 30 ? "Oak" : "Willow",
            room <= 30 ? "Ground" : "First",
            room % 3 !== 0,
          ],
        );
      }

      const roleIds = new Map<string, string>();
      for (const [index, role] of BUILTIN_ROLES.entries()) {
        const id = uuid("500", index + 1);
        roleIds.set(role.key, id);
        await client.query(
          `INSERT INTO role (id, key, name, description, permissions, scope_kind, is_builtin)
           VALUES ($1, $2, $3, $4, $5, $6, true)`,
          [id, role.key, role.name, role.description, [...role.permissions], role.scopeKind],
        );
      }

      for (const user of Object.values(DEMO.users)) {
        await client.query(
          `INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, $2, $3, 'invited')`,
          [user.id, user.name, user.email],
        );
        const tenantWide = user.role === "owner";
        await client.query(
          `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
           VALUES ($1, $2, $3, 'Demo seed')`,
          [user.id, roleIds.get(user.role), tenantWide ? null : DEMO.locationId],
        );
      }

      for (const p of PEOPLE) {
        const personId = uuid("600", p.n);
        // Admitted on 1 September: the status began then (people.md rule 2), and a list of needs
        // is a record of them while an empty one stays "not recorded" (HZ-023).
        await client.query(
          `INSERT INTO person (id, location_id, status, nhs_number, given_name, family_name, preferred_name,
                               date_of_birth, room_label, allergy_status, communication_needs, first_language,
                               communication_needs_status, status_changed_at)
           VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10, 'en', $11, $12)`,
          [
            personId,
            DEMO.locationId,
            p.nhs,
            p.given,
            p.family,
            p.preferred,
            p.dob,
            p.room,
            p.allergyStatus,
            JSON.stringify(p.communication),
            p.communication.length > 0 ? "recorded" : "not_recorded",
            DEMO_ADMITTED_AT,
          ],
        );
        for (const allergy of p.allergies) {
          await client.query(
            `INSERT INTO allergy (person_id, substance, severity, reaction, category)
             VALUES ($1, $2, $3, $4, 'other')`,
            [personId, allergy.substance, allergy.severity, allergy.reaction],
          );
        }
        await client.query(
          `INSERT INTO placement (person_id, service_id, room_id, type, start_date)
           VALUES ($1, $2, $3, 'permanent', '2026-09-01')`,
          [
            personId,
            p.n % 2 === 0 ? DEMO.residentialServiceId : DEMO.nursingServiceId,
            uuid("400", Number(p.room)),
          ],
        );
        // The room label on the header comes from this history (people.md rule 6, HZ-001).
        await client.query(
          `INSERT INTO bed_occupancy (person_id, room_id, bed, from_date, reason)
           VALUES ($1, $2, 1, '2026-09-01', 'Admission')`,
          [personId, uuid("400", Number(p.room))],
        );
        await client.query(
          `INSERT INTO contact (person_id, role, given_name, family_name, relationship, email, is_next_of_kin)
           VALUES ($1, 'next_of_kin', 'Relative', $2, 'Child', $3, true)`,
          [personId, p.family, `relative.${p.family.toLowerCase()}@example.invalid`],
        );
      }

      // The demo care worker is assigned to the first three residents.
      for (const n of [1, 2, 3]) {
        await client.query(
          "INSERT INTO person_assignment (tenant_user_id, person_id) VALUES ($1, $2)",
          [DEMO.users.carer.id, uuid("600", n)],
        );
      }
      return { created: true };
    });
  } finally {
    client.release();
  }
}

/** Links a demo tenant user to the Better Auth identity created for it, and activates it. */
export async function linkDemoUser(
  ownerPool: pg.Pool,
  key: DemoUserKey,
  authUserId: string,
): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await inTenant(client, DEMO.tenantId, async () => {
      await client.query(
        "UPDATE tenant_user SET auth_user_id = $1, status = 'active' WHERE id = $2",
        [authUserId, DEMO.users[key].id],
      );
    });
  } finally {
    client.release();
  }
}
