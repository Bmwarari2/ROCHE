/**
 * Demo mode (EXPO_PUBLIC_DEMO_MODE=1): three invented people seeded into a separate, local-only
 * encrypted database so the People list can be exercised without the API. Every value is invented:
 * names from the Example family, NHS numbers from the 999 test range, no SNOMED codes.
 */
import type { Me } from "../auth/auth-client";

export const DEMO_TENANT_ID = "00000000-0000-4000-8000-00000000d001";
export const DEMO_LOCATION_ID = "00000000-0000-4000-8000-00000000d101";
export const DEMO_SEEDED_AT_KEY = "demo_seeded_at";

export const demoMe: Me = {
  user: { id: "00000000-0000-4000-8000-00000000d201", name: "Demo Carer" },
  tenant: { id: DEMO_TENANT_ID, name: "Example Care (demo)" },
  locations: [{ id: DEMO_LOCATION_ID, name: "Example House" }],
  permissions: ["people.person.read"],
};

interface DemoPerson {
  readonly id: string;
  readonly given_name: string;
  readonly family_name: string;
  readonly preferred_name: string | null;
  readonly date_of_birth: string;
  readonly nhs_number: string;
  readonly room_label: string;
  readonly allergy_status: "unknown" | "no_known_allergies" | "has_allergies";
  readonly communication_needs: ReadonlyArray<{ display: string; preferredFormat: string | null }>;
}

interface DemoAllergy {
  readonly id: string;
  readonly person_id: string;
  readonly substance: string;
  readonly reaction: string;
  readonly severity: string;
  readonly status: string;
}

export const demoPeople: readonly DemoPerson[] = [
  {
    id: "00000000-0000-4000-8000-00000000d301",
    given_name: "Ada",
    family_name: "Example",
    preferred_name: null,
    date_of_birth: "1938-04-12",
    nhs_number: "9990000018",
    room_label: "Room 1",
    allergy_status: "has_allergies",
    communication_needs: [{ display: "Large print", preferredFormat: "Large print, 16 point" }],
  },
  {
    id: "00000000-0000-4000-8000-00000000d302",
    given_name: "Beatrice",
    family_name: "Sample",
    preferred_name: "Bea",
    date_of_birth: "1945-11-02",
    nhs_number: "9990000026",
    room_label: "Room 2",
    allergy_status: "no_known_allergies",
    communication_needs: [],
  },
  {
    id: "00000000-0000-4000-8000-00000000d303",
    given_name: "Callum",
    family_name: "Placeholder",
    preferred_name: "Cal",
    date_of_birth: "1951-07-30",
    nhs_number: "9990000034",
    room_label: "Room 3",
    allergy_status: "unknown",
    communication_needs: [
      { display: "British Sign Language interpreter", preferredFormat: null },
      { display: "Easy read information", preferredFormat: "Easy read" },
    ],
  },
];

export const demoAllergies: readonly DemoAllergy[] = [
  {
    id: "00000000-0000-4000-8000-00000000d401",
    person_id: "00000000-0000-4000-8000-00000000d301",
    substance: "Penicillin",
    reaction: "Rash",
    severity: "moderate",
    status: "active",
  },
  {
    // Resolved, so it must not be counted or shown as active.
    id: "00000000-0000-4000-8000-00000000d402",
    person_id: "00000000-0000-4000-8000-00000000d301",
    substance: "Sticking plaster",
    reaction: "Skin irritation",
    severity: "mild",
    status: "resolved",
  },
];

export interface SqlStatement {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number | null>;
}

/** Insert statements for the demo database, in order. */
export function demoSeedStatements(seededAt: Date): SqlStatement[] {
  const now = seededAt.toISOString();
  const statements: SqlStatement[] = [
    {
      sql: "INSERT INTO location (id, tenant_id, name, cqc_location_id, nation) VALUES (?, ?, ?, ?, ?)",
      params: [DEMO_LOCATION_ID, DEMO_TENANT_ID, "Example House", null, "england"],
    },
  ];
  for (const p of demoPeople) {
    statements.push({
      sql: `INSERT INTO person (id, tenant_id, location_id, status, given_name, family_name,
        preferred_name, date_of_birth, nhs_number, room_label, photo_document_id,
        communication_needs, allergy_status, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        p.id,
        DEMO_TENANT_ID,
        DEMO_LOCATION_ID,
        "active",
        p.given_name,
        p.family_name,
        p.preferred_name,
        p.date_of_birth,
        p.nhs_number,
        p.room_label,
        null,
        JSON.stringify(p.communication_needs.map((n) => ({ code: null, ...n }))),
        p.allergy_status,
        now,
        1,
      ],
    });
  }
  for (const a of demoAllergies) {
    statements.push({
      sql: `INSERT INTO allergy (id, tenant_id, person_id, substance, reaction, severity, status,
        recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        a.id,
        DEMO_TENANT_ID,
        a.person_id,
        a.substance,
        a.reaction,
        a.severity,
        a.status,
        now,
      ],
    });
  }
  statements.push(...demoCareStatements(seededAt));
  statements.push({
    sql: "INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)",
    params: ["00000000-0000-4000-8000-00000000d501", DEMO_SEEDED_AT_KEY, now],
  });
  return statements;
}

// ------------------------------------------------------------------------------------------------
// Care mode demo records, all invented. Ada has a DNACPR decision whose review date has passed (so
// the header shows the decision and the overdue review), IDDSI levels and a care plan; Bea has a
// ReSPECT plan and SpO2 scale 2 recorded by a clinician; Cal has no resuscitation record, so the
// header reads "not recorded".
// ------------------------------------------------------------------------------------------------

const [ADA, BEA] = [demoPeople[0]?.id ?? "", demoPeople[1]?.id ?? ""];
const DEMO_PLAN_ID = "00000000-0000-4000-8000-00000000d601";

function insert(table: string, row: Record<string, string | number | null>): SqlStatement {
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params: columns.map((c) => row[c] ?? null),
  };
}

/** Care records for the demo people; entries are timed relative to when the demo was seeded. */
export function demoCareStatements(seededAt: Date): SqlStatement[] {
  const now = seededAt.toISOString();
  const hoursAgo = (hours: number) =>
    new Date(seededAt.getTime() - hours * 3_600_000).toISOString();
  const tenant = { tenant_id: DEMO_TENANT_ID };
  const entry = (id: string, person: string, hours: number) => ({
    id,
    ...tenant,
    person_id: person,
    location_id: DEMO_LOCATION_ID,
    occurred_at: hoursAgo(hours),
    recorded_at: hoursAgo(hours - 0.1),
    device_time: hoursAgo(hours - 0.05),
    late_entry: 0,
    clock_drift: 0,
    supersedes_id: null,
    correction_reason: null,
    created_by: demoMe.user.id,
  });
  return [
    insert("person_care_profile", {
      id: "00000000-0000-4000-8000-00000000d701",
      ...tenant,
      person_id: ADA,
      iddsi_food_level: "5",
      iddsi_drink_level: "2",
      iddsi_advised_by: "Speech and language therapist (invented)",
      fluid_target_ml: 1500,
      spo2_scale2: 0,
      skin_risk: "at_risk",
      updated_at: now,
      version: 1,
    }),
    insert("person_care_profile", {
      id: "00000000-0000-4000-8000-00000000d702",
      ...tenant,
      person_id: BEA,
      iddsi_food_level: "7",
      iddsi_drink_level: "0",
      fluid_target_ml: null,
      spo2_scale2: 1,
      skin_risk: "not_at_risk",
      updated_at: now,
      version: 1,
    }),
    insert("advance_care_record", {
      id: "00000000-0000-4000-8000-00000000d801",
      ...tenant,
      person_id: ADA,
      kind: "dnacpr",
      status: "active",
      cpr_decision: "do_not_attempt_cpr",
      clinician_name: "Dr Ivy Example",
      clinician_role: "GP",
      completed_on: "2026-03-02",
      review_due_on: "2026-09-01",
      details: null,
      updated_at: now,
      version: 1,
    }),
    insert("advance_care_record", {
      id: "00000000-0000-4000-8000-00000000d802",
      ...tenant,
      person_id: BEA,
      kind: "respect",
      status: "active",
      cpr_decision: "attempt_cpr",
      clinician_name: "Dr Ivy Example",
      clinician_role: "GP",
      completed_on: "2026-05-14",
      review_due_on: "2027-05-14",
      details: "Invented example: hospital admission if needed.",
      updated_at: now,
      version: 1,
    }),
    insert("care_plan", {
      id: DEMO_PLAN_ID,
      ...tenant,
      person_id: ADA,
      location_id: DEMO_LOCATION_ID,
      status: "active",
      published_version: 2,
      summary: "Ada likes her mornings slow, with tea before anything else.",
      review_due_on: "2027-01-31",
      published_at: "2026-08-01T10:00:00.000Z",
      sign_off_kind: "person",
      signed_off_at: "2026-08-01T11:00:00.000Z",
      updated_at: now,
      version: 1,
    }),
    insert("care_plan_section", {
      id: "00000000-0000-4000-8000-00000000d611",
      ...tenant,
      person_id: ADA,
      plan_id: DEMO_PLAN_ID,
      domain: "mobility",
      need: "Walks short distances with a frame; unsteady when tired.",
      outcome: "I want to walk to the lounge for lunch myself.",
      strengths: "Remembers to use her frame.",
      contingency: "If she is too tired, offer the wheelchair and record why.",
      updated_at: now,
      version: 1,
    }),
    insert("care_plan_section", {
      id: "00000000-0000-4000-8000-00000000d612",
      ...tenant,
      person_id: ADA,
      plan_id: DEMO_PLAN_ID,
      domain: "nutrition_and_hydration",
      need: "Minced and moist food and mildly thick drinks, as advised.",
      outcome: "I like a cup of tea with every meal.",
      strengths: "Feeds herself with a large-handled spoon.",
      contingency: null,
      updated_at: now,
      version: 1,
    }),
    insert("care_plan_action", {
      id: "00000000-0000-4000-8000-00000000d621",
      ...tenant,
      person_id: ADA,
      plan_id: DEMO_PLAN_ID,
      section_id: "00000000-0000-4000-8000-00000000d611",
      action: "Walk with Ada to the lounge, frame within reach",
      role_key: "care_worker",
      when_text: "Before lunch",
      recurrence: null,
      risk_assessment_id: null,
      updated_at: now,
      version: 1,
    }),
    insert("care_plan_action", {
      id: "00000000-0000-4000-8000-00000000d622",
      ...tenant,
      person_id: ADA,
      plan_id: DEMO_PLAN_ID,
      section_id: "00000000-0000-4000-8000-00000000d612",
      action: "Offer a mildly thick drink",
      role_key: "care_worker",
      when_text: "Every 2 hours while awake",
      recurrence: null,
      risk_assessment_id: null,
      updated_at: now,
      version: 1,
    }),
    insert("risk_assessment", {
      id: "00000000-0000-4000-8000-00000000d901",
      ...tenant,
      person_id: ADA,
      template_key: "falls",
      template_version: "1",
      hazard: "Falls when walking to the lounge",
      who_at_risk: "Ada",
      risk_rating: null,
      risk_band: null,
      residual_rating: null,
      residual_band: null,
      controls: JSON.stringify(["Frame within reach", "Sensor mat at night"]),
      positive_risk_statement: "Ada chooses to walk; staff walk with her.",
      person_views: "I would rather walk than be pushed.",
      assessed_on: "2026-08-01",
      review_due_on: "2027-01-31",
      status: "active",
      updated_at: now,
      version: 1,
    }),
    insert("risk_assessment", {
      id: "00000000-0000-4000-8000-00000000d902",
      ...tenant,
      person_id: ADA,
      template_key: "choking",
      template_version: "1",
      hazard: "Choking on food of the wrong texture",
      who_at_risk: "Ada",
      risk_rating: 8,
      risk_band: "high",
      residual_rating: 4,
      residual_band: "moderate",
      controls: JSON.stringify(["Minced and moist diet", "Sit upright to eat"]),
      positive_risk_statement: null,
      person_views: null,
      assessed_on: "2026-08-01",
      review_due_on: "2026-10-01",
      status: "active",
      updated_at: now,
      version: 1,
    }),
    insert("assessment", {
      id: "00000000-0000-4000-8000-00000000da01",
      ...tenant,
      person_id: ADA,
      location_id: DEMO_LOCATION_ID,
      tool_key: "must",
      tool_version: "bapen-2011",
      score: 1,
      band: "medium",
      occurred_at: "2026-10-01T10:00:00.000Z",
      next_due_on: "2026-11-01",
      supersedes_id: null,
      correction_reason: null,
      late_entry: 0,
    }),
    insert("care_note", {
      ...entry("00000000-0000-4000-8000-00000000db01", ADA, 20),
      category: "personal_care",
      body: "Ada had a wash and chose her blue cardigan. Skin on heels checked and intact.",
      tags: "[]",
    }),
    insert("observation", {
      ...entry("00000000-0000-4000-8000-00000000db02", ADA, 19),
      chart: "fluid_intake",
      chart_values: JSON.stringify({
        chart: "fluid_intake",
        ml: 200,
        iddsiLevel: "2",
        refused: false,
      }),
      flags: JSON.stringify({ iddsi: { outcome: "match" }, iddsiAlert: false }),
    }),
  ];
}
