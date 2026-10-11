import { column, Schema, Table } from "@powersync/common";

/**
 * Local (on-device) SQLite schema for the offline-first apps.
 *
 * Only the columns a care worker needs at the point of care are synced. Every table carries
 * tenant_id so the client can assert it never holds another tenant's rows, and the server-side
 * sync streams (../streams/sync-config.yaml) are the authority for what reaches a device. Column
 * names here must match the stream queries' output columns.
 *
 * PowerSync adds the `id` column (text UUID) to every table automatically.
 */

/** People the signed-in user is allowed to see offline (assigned people or their locations). */
const person = new Table(
  {
    tenant_id: column.text,
    location_id: column.text,
    status: column.text,
    given_name: column.text,
    family_name: column.text,
    preferred_name: column.text,
    date_of_birth: column.text,
    nhs_number: column.text,
    room_label: column.text,
    /** Fetch the image through the API (`GET /v1/people/{id}/photo`); never a pre-signed URL. */
    photo_document_id: column.text,
    /** JSON array of { code, display, preferredFormat } (Accessible Information Standard). */
    communication_needs: column.text,
    /** 'unknown' | 'no_known_allergies' | 'has_allergies' (HZ-007: unknown is not "none"). */
    allergy_status: column.text,
    updated_at: column.text,
    version: column.integer,
  },
  { indexes: { by_location: ["location_id"], by_family_name: ["family_name"] } },
);

/** Allergies are reference data that must never be evicted while an assignment stands. */
const allergy = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    substance: column.text,
    reaction: column.text,
    severity: column.text,
    status: column.text,
    recorded_at: column.text,
  },
  { indexes: { by_person: ["person_id"] } },
);

/** Locations the user can work at, for the location switcher. */
const location = new Table({
  tenant_id: column.text,
  name: column.text,
  cqc_location_id: column.text,
  nation: column.text,
});

/** Local-only bookkeeping: last successful sync, queued writes, clock drift (hazard HZ-002, HZ-006). */
const sync_meta = new Table(
  {
    key: column.text,
    value: column.text,
  },
  { localOnly: true },
);

export const AppSchema = new Schema({ person, allergy, location, sync_meta });

export type Database = (typeof AppSchema)["types"];
export type PersonRecord = Database["person"];
export type AllergyRecord = Database["allergy"];
export type LocationRecord = Database["location"];

/** Tables that hold reference data for assigned people and are never evicted (section 17.2). */
export const NEVER_EVICT_TABLES = ["person", "allergy", "location"] as const;
