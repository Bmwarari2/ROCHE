import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { location, tenantUser } from "./platform";

/**
 * Staff wellbeing and voice (scheduling.md section 16; SCHED-011): pulse surveys, recognition and
 * wellbeing check-ins. The rules live in packages/domain/src/scheduling/wellbeing. Row-level
 * security, the guards and the two definer functions that alone reach survey responses are in
 * migration 0115.
 */

/** `SURVEY_STATES` in packages/domain; a test keeps the lists in step. */
export const PULSE_SURVEY_STATE_CODES = ["draft", "open", "closed"] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });
const locationRef = (name: string, t: { tenantId: AnyPgColumn; locationId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.locationId],
    foreignColumns: [location.tenantId, location.id],
  });

/**
 * A pulse survey: one home's staff (`location_id`), or the whole organisation's (null). Its
 * questions and dates are fixed once it opens; it moves draft, open, closed. No personal data.
 */
export const pulseSurvey = pgTable(
  "pulse_survey",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id"),
    title: text("title").notNull(),
    /** `[{ id, kind: "scale" | "free_text", text }]`. */
    questions: jsonb("questions").notNull(),
    opensOn: date("opens_on").notNull(),
    closesOn: date("closes_on").notNull(),
    state: text("state").notNull().default("draft"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("pulse_survey_tenant_id_id_key").on(t.tenantId, t.id),
    locationRef("pulse_survey_location_fk", t),
    index("pulse_survey_location_idx").on(t.tenantId, t.locationId, t.state),
    check("pulse_survey_title", sql`char_length(btrim(title)) BETWEEN 1 AND 120`),
    check("pulse_survey_state", sql`state IN ('draft', 'open', 'closed')`),
    check("pulse_survey_dates", sql`closes_on >= opens_on`),
    check(
      "pulse_survey_questions",
      sql`jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 20`,
    ),
  ],
);

/**
 * That a member took part in a survey: nothing else, no time and no link to a response, so a
 * second response is refused and the member can see they answered.
 */
export const pulseSurveyParticipation = pgTable(
  "pulse_survey_participation",
  {
    tenantId: tenantId(),
    surveyId: uuid("survey_id").notNull(),
    memberId: uuid("member_id").notNull(),
  },
  (t) => [
    primaryKey({
      name: "pulse_survey_participation_pkey",
      columns: [t.tenantId, t.surveyId, t.memberId],
    }),
    foreignKey({
      name: "pulse_survey_participation_survey_fk",
      columns: [t.tenantId, t.surveyId],
      foreignColumns: [pulseSurvey.tenantId, pulseSurvey.id],
    }),
    staffRef("pulse_survey_participation_member_fk", t, t.memberId),
  ],
);

/**
 * An anonymous survey response (section 16 rule 3): a random id, the survey, the UK week it came
 * in and the answers. No member, no creator, no exact time. The application role has no grant on
 * it: `app.submit_pulse_response` writes it and `app.pulse_survey_results` reads it, above the
 * minimum group size only.
 */
export const pulseSurveyResponse = pgTable(
  "pulse_survey_response",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: tenantId(),
    surveyId: uuid("survey_id").notNull(),
    submittedWeek: date("submitted_week").notNull(),
    answers: jsonb("answers").notNull(),
  },
  (t) => [
    foreignKey({
      name: "pulse_survey_response_survey_fk",
      columns: [t.tenantId, t.surveyId],
      foreignColumns: [pulseSurvey.tenantId, pulseSurvey.id],
    }),
    index("pulse_survey_response_survey_idx").on(t.tenantId, t.surveyId),
    check("pulse_survey_response_answers", sql`jsonb_typeof(answers) = 'object'`),
    check("pulse_survey_response_week", sql`extract(isodow FROM submitted_week) = 1`),
  ],
);

/** A colleague's thanks (rule 5): append-only, never part of a performance record. */
export const recognition = pgTable(
  "recognition",
  {
    id: id(),
    tenantId: tenantId(),
    fromMemberId: uuid("from_member_id").notNull(),
    toMemberId: uuid("to_member_id").notNull(),
    locationId: uuid("location_id").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    staffRef("recognition_from_fk", t, t.fromMemberId),
    staffRef("recognition_to_fk", t, t.toMemberId),
    locationRef("recognition_location_fk", t),
    index("recognition_to_idx").on(t.tenantId, t.toMemberId, t.createdAt),
    index("recognition_location_idx").on(t.tenantId, t.locationId, t.createdAt),
    check("recognition_not_self", sql`from_member_id <> to_member_id`),
    check("recognition_message", sql`char_length(btrim(message)) BETWEEN 1 AND 500`),
  ],
);

/**
 * A member's own wellbeing check-in (rule 6): seen by a manager at their home only while
 * `shared_at` is set, which only the member sets or clears. Possibly special category (health).
 */
export const wellbeingCheckIn = pgTable(
  "wellbeing_check_in",
  {
    id: id(),
    tenantId: tenantId(),
    memberId: uuid("member_id").notNull(),
    locationId: uuid("location_id").notNull(),
    mood: smallint("mood").notNull(),
    note: text("note"),
    sharedAt: timestamp("shared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    staffRef("wellbeing_check_in_member_fk", t, t.memberId),
    locationRef("wellbeing_check_in_location_fk", t),
    index("wellbeing_check_in_member_idx").on(t.tenantId, t.memberId, t.createdAt),
    index("wellbeing_check_in_location_idx").on(t.tenantId, t.locationId, t.createdAt),
    check("wellbeing_check_in_mood", sql`mood BETWEEN 1 AND 5`),
    check("wellbeing_check_in_note", sql`note IS NULL OR char_length(note) <= 1000`),
  ],
);
