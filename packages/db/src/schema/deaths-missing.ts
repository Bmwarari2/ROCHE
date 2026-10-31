import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { id, mutableColumns, tenantId } from "./_columns";
import { person } from "./people";
import { exitRecord } from "./people-lifecycle";
import { document, location, tenantUser } from "./platform";
import { incident } from "./safety";

/**
 * Deaths and missing persons (Phase 2 slice 37; SAFE-014, SAFE-015; safety.md slice 37; HZ-013,
 * HZ-127). Codes are kept in step with packages/domain by `deaths-missing.test.ts`. Clocks (the
 * mortality review's due date apart, fixed when the record opens) are worked out when read.
 */

const DEATH_RECORD_STATUS_SQL = sqlList(["open", "closed", "withdrawn"]);
const RECORDED_STEP_SQL = sqlList([
  "verification_of_death",
  "family_informed",
  "medical_examiner_pack",
  "cqc_reg16_notification",
  "leder_notification",
  "police_informed",
  "preserve_room_and_equipment",
]);
const STEP_OUTCOME_SQL = sqlList(["done", "not_needed"]);
const EPISODE_STATUS_SQL = sqlList(["open", "found", "closed"]);
const TIMELINE_KIND_SQL = sqlList([
  "last_seen",
  "noticed_missing",
  "search_started",
  "search",
  "sighting",
  "police_called",
  "found",
  "welfare_check",
  "debrief",
  "note",
]);
const ONCE_KIND_SQL = sqlList([
  "last_seen",
  "noticed_missing",
  "search_started",
  "police_called",
  "found",
  "welfare_check",
  "debrief",
]);

/** One per death recorded on a person's exit: the judgement, the steps and the mortality review. */
export const deathRecord = pgTable(
  "death_record",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    locationId: uuid("location_id").notNull(),
    /** The exit that recorded the death (people.md section 6). */
    exitRecordId: uuid("exit_record_id").notNull(),
    /** The incident about the death, when there is one. */
    incidentId: uuid("incident_id"),
    diedAt: timestamp("died_at", { withTimezone: true }).notNull(),
    /** The clinician's judgement, as recorded; null until recorded (the plan assumes not). */
    expected: boolean("expected"),
    /** Whether the cause may be unnatural or the circumstances suspicious; null until recorded. */
    possiblyUnnatural: boolean("possibly_unnatural"),
    /** The clinician whose judgement it records: name and role. */
    judgedBy: text("judged_by"),
    learningDisabilityOrAutism: boolean("learning_disability_or_autism").notNull(),
    status: text("status").notNull().default("open"),
    /** `mortality_review.due_days` after the death, from the rate table when the record opened. */
    reviewDueAt: timestamp("review_due_at", { withTimezone: true }).notNull(),
    reviewFindings: text("review_findings"),
    reviewLessons: text("review_lessons"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    /** Why it was withdrawn: the death was recorded in error and corrected. */
    withdrawnReason: text("withdrawn_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("death_record_tenant_id_id_key").on(t.tenantId, t.id),
    unique("death_record_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    unique("death_record_exit_key").on(t.tenantId, t.exitRecordId),
    index("death_record_open_idx").on(t.tenantId, t.status, t.diedAt),
    foreignKey({
      name: "death_record_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "death_record_exit_fk",
      columns: [t.tenantId, t.personId, t.exitRecordId],
      foreignColumns: [exitRecord.tenantId, exitRecord.personId, exitRecord.id],
    }),
    foreignKey({
      name: "death_record_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "death_record_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "death_record_reviewed_by_fk",
      columns: [t.tenantId, t.reviewedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "death_record_closed_by_fk",
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("death_record_status", sql`status IN (${DEATH_RECORD_STATUS_SQL})`),
    check(
      "death_record_judged_by",
      sql`judged_by IS NULL OR char_length(btrim(judged_by)) BETWEEN 3 AND 200`,
    ),
    check(
      "death_record_review",
      sql`(reviewed_at IS NULL) = (reviewed_by IS NULL)
        AND (reviewed_at IS NULL OR (coalesce(char_length(btrim(review_findings)), 0) BETWEEN 20 AND 10000
          AND coalesce(char_length(btrim(review_lessons)), 0) BETWEEN 20 AND 10000))`,
    ),
    check(
      "death_record_closed",
      sql`(status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL)
        AND (status = 'withdrawn') = (withdrawn_reason IS NOT NULL)
        AND (withdrawn_reason IS NULL OR char_length(btrim(withdrawn_reason)) BETWEEN 3 AND 1000)`,
    ),
  ],
);

/** Each step of a death as recorded (append-only; the latest for a step counts). */
export const deathStep = pgTable(
  "death_step",
  {
    id: id(),
    tenantId: tenantId(),
    deathRecordId: uuid("death_record_id").notNull(),
    personId: uuid("person_id").notNull(),
    step: text("step").notNull(),
    /** `done`, or `not_needed` with the reason in `note`. */
    outcome: text("outcome").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    note: text("note"),
    /** The police reference, for telling the police. */
    reference: text("reference"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid("recorded_by").default(sql`app.current_user_id()`),
  },
  (t) => [
    unique("death_step_tenant_id_id_key").on(t.tenantId, t.id),
    index("death_step_record_idx").on(t.tenantId, t.deathRecordId, t.recordedAt),
    foreignKey({
      name: "death_step_record_fk",
      columns: [t.tenantId, t.personId, t.deathRecordId],
      foreignColumns: [deathRecord.tenantId, deathRecord.personId, deathRecord.id],
    }),
    foreignKey({
      name: "death_step_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "death_step_recorded_by_fk",
      columns: [t.tenantId, t.recordedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("death_step_step", sql`step IN (${RECORDED_STEP_SQL})`),
    check("death_step_outcome", sql`outcome IN (${STEP_OUTCOME_SQL})`),
    check(
      "death_step_text",
      sql`(note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 2000)
        AND (reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 100)
        AND (outcome = 'done' OR coalesce(char_length(btrim(note)), 0) >= 20)`,
    ),
  ],
);

/** A missing person episode, on its missing person (or absconding) incident. */
export const missingEpisode = pgTable(
  "missing_episode",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    locationId: uuid("location_id").notNull(),
    incidentId: uuid("incident_id").notNull(),
    status: text("status").notNull().default("open"),
    /** The tenant's risk assessment says call the police at once. */
    immediateRisk: boolean("immediate_risk").notNull().default(false),
    /** Under a DoLS authorisation or the Mental Health Act when the episode opened. */
    underDolsOrMha: boolean("under_dols_or_mha").notNull().default(false),
    /** The Herbert Protocol profile's version when the episode opened; null when there was none. */
    herbertProfileVersion: integer("herbert_profile_version"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("missing_episode_tenant_id_id_key").on(t.tenantId, t.id),
    unique("missing_episode_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    uniqueIndex("missing_episode_one_open")
      .on(t.tenantId, t.personId)
      .where(sql`status <> 'closed' AND deleted_at IS NULL`),
    index("missing_episode_incident_idx").on(t.tenantId, t.incidentId),
    foreignKey({
      name: "missing_episode_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "missing_episode_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "missing_episode_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "missing_episode_closed_by_fk",
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("missing_episode_status", sql`status IN (${EPISODE_STATUS_SQL})`),
    check(
      "missing_episode_closed",
      sql`(status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL)`,
    ),
  ],
);

/** The episode's timeline and search log (append-only; a client id makes a resend a no-op). */
export const missingEvent = pgTable(
  "missing_event",
  {
    id: id(),
    tenantId: tenantId(),
    episodeId: uuid("episode_id").notNull(),
    personId: uuid("person_id").notNull(),
    kind: text("kind").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** The police reference, for `police_called`. */
    reference: text("reference"),
    /** Where was searched, for `search`. */
    area: text("area"),
    note: text("note"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid("recorded_by").default(sql`app.current_user_id()`),
  },
  (t) => [
    unique("missing_event_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("missing_event_once")
      .on(t.tenantId, t.episodeId, t.kind)
      .where(sql`kind IN (${ONCE_KIND_SQL})`),
    index("missing_event_episode_idx").on(t.tenantId, t.episodeId, t.at),
    foreignKey({
      name: "missing_event_episode_fk",
      columns: [t.tenantId, t.personId, t.episodeId],
      foreignColumns: [missingEpisode.tenantId, missingEpisode.personId, missingEpisode.id],
    }),
    foreignKey({
      name: "missing_event_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "missing_event_recorded_by_fk",
      columns: [t.tenantId, t.recordedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("missing_event_kind", sql`kind IN (${TIMELINE_KIND_SQL})`),
    check(
      "missing_event_text",
      sql`(kind <> 'police_called' OR coalesce(char_length(btrim(reference)), 0) BETWEEN 1 AND 100)
        AND (reference IS NULL OR kind = 'police_called')
        AND (kind <> 'search' OR coalesce(char_length(btrim(area)), 0) BETWEEN 1 AND 500)
        AND (area IS NULL OR kind = 'search')
        AND (note IS NULL OR char_length(note) <= 4000)
        AND (kind NOT IN ('found', 'welfare_check', 'debrief', 'sighting', 'note')
          OR coalesce(char_length(btrim(note)), 0) >= 10)`,
    ),
  ],
);

/** The Herbert Protocol profile: one per person, ready to hand to the police. */
export const herbertProfile = pgTable(
  "herbert_profile",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** A recent photograph: one of the person's documents. */
    photoDocumentId: uuid("photo_document_id"),
    physicalDescription: text("physical_description").notNull(),
    distinguishingFeatures: text("distinguishing_features"),
    usualClothing: text("usual_clothing"),
    medicalNeeds: text("medical_needs"),
    mobility: text("mobility"),
    communication: text("communication"),
    placesLikely: text("places_likely").notNull(),
    peopleLikely: text("people_likely"),
    routines: text("routines"),
    phoneOrTracker: text("phone_or_tracker"),
    previousEpisodes: text("previous_episodes"),
    approach: text("approach"),
    /** Who it was checked with: the person, a relative, staff. */
    reviewedWith: text("reviewed_with"),
    reviewedOn: date("reviewed_on", { mode: "string" }).notNull(),
    reviewedBy: uuid("reviewed_by").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("herbert_profile_tenant_id_id_key").on(t.tenantId, t.id),
    unique("herbert_profile_person_key").on(t.tenantId, t.personId),
    foreignKey({
      name: "herbert_profile_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "herbert_profile_photo_fk",
      columns: [t.tenantId, t.photoDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    foreignKey({
      name: "herbert_profile_reviewed_by_fk",
      columns: [t.tenantId, t.reviewedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "herbert_profile_required",
      sql`char_length(btrim(physical_description)) BETWEEN 10 AND 4000
        AND char_length(btrim(places_likely)) BETWEEN 10 AND 4000`,
    ),
    check(
      "herbert_profile_text",
      sql`(distinguishing_features IS NULL OR char_length(distinguishing_features) <= 4000)
        AND (usual_clothing IS NULL OR char_length(usual_clothing) <= 4000)
        AND (medical_needs IS NULL OR char_length(medical_needs) <= 4000)
        AND (mobility IS NULL OR char_length(mobility) <= 4000)
        AND (communication IS NULL OR char_length(communication) <= 4000)
        AND (people_likely IS NULL OR char_length(people_likely) <= 4000)
        AND (routines IS NULL OR char_length(routines) <= 4000)
        AND (phone_or_tracker IS NULL OR char_length(phone_or_tracker) <= 1000)
        AND (previous_episodes IS NULL OR char_length(previous_episodes) <= 4000)
        AND (approach IS NULL OR char_length(approach) <= 4000)
        AND (reviewed_with IS NULL OR char_length(reviewed_with) <= 500)`,
    ),
  ],
);
