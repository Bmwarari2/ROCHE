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
  statements.push({
    sql: "INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)",
    params: ["00000000-0000-4000-8000-00000000d501", DEMO_SEEDED_AT_KEY, now],
  });
  return statements;
}
