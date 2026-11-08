/**
 * Retention registry: the safety context (retention sweeps plan, slice 3). Incidents carry their
 * own class (care_record, or serious_incident once a notification applies) and their people,
 * answers, investigations and candour records go with them; deaths and missing episodes are part
 * of the person's care record (provisional, H-1558); an outbreak's line list takes care_record for
 * residents and outbreak_staff_case for staff (H-767).
 */

import {
  byValue,
  careEndedOf,
  childOf,
  classes,
  col,
  derived,
  entry,
  firstOf,
  NO_SUBJECT,
  PARENT,
  parentIs,
  person,
  personRecord,
  type RegistryContext,
  rowClass,
  staff,
} from "./registry";

const incidentChild = (table: string, extra: Parameters<typeof childOf>[4] = {}) =>
  childOf(table, "incident", "incident_id", person(null), extra);

const speakUpChild = (table: string, column: string) =>
  childOf(table, "speak_up_concern", "concern_id", staff(column), {
    note: "Restricted silo",
  });

export const SAFETY_REGISTRY: RegistryContext = {
  context: "safety",
  entries: [
    entry(
      "incident",
      rowClass("retention_class", "care_record", "serious_incident"),
      {
        closedAt: col("closed_at"),
        careEnded: derived("the latest care end of the people in person_ids", "person_ids"),
      },
      person("person_ids"),
    ),
    incidentChild("incident_person", {
      subject: person("person_id"),
      otherSubjects: [staff("tenant_user_id")],
    }),
    incidentChild("classifier_answer"),
    incidentChild("investigation", { otherSubjects: [staff("lead_tenant_user_id")] }),
    incidentChild("candour_record", { subject: person("person_id") }),
    entry(
      "statutory_notification",
      rowClass("retention_class", "serious_incident", "riddor_report"),
      {
        closedAt: derived(
          "the closure of its incident; a notification with no incident, its submission",
          "incident_id",
          "submitted_at",
        ),
        createdAt: col("created_at"),
      },
      person("person_id"),
      { provisional: ["DPO decision"] },
    ),
    entry(
      "safeguarding_concern",
      rowClass("retention_class", "serious_incident"),
      { closedAt: col("closed_at") },
      person("person_id"),
    ),
    entry(
      "complaint",
      rowClass("retention_class", "complaint"),
      { closedAt: col("closed_at") },
      person("person_id"),
      {
        provisional: ["H-1558"],
      },
    ),
    entry(
      "compliment",
      rowClass("retention_class", "complaint"),
      { closedAt: col("received_at") },
      person("person_id"),
      {
        provisional: ["H-1558", "H-1584"],
        note: "A compliment never closes: counted from receipt",
      },
    ),

    personRecord("death_record", "care_record", { provisional: ["H-1558"] }),
    personRecord("death_step", "care_record", {
      parent: parentIs("death_record", "death_record_id"),
      provisional: ["H-1558"],
    }),
    personRecord("herbert_profile", "care_record", { provisional: ["H-1558"] }),
    personRecord("missing_episode", "care_record", { provisional: ["H-1558"] }),
    personRecord("missing_event", "care_record", {
      parent: parentIs("missing_episode", "episode_id"),
      provisional: ["H-1558"],
    }),

    entry(
      "disclosure_request",
      classes("serious_incident"),
      { closedAt: firstOf("handed_over_at", "released_at") },
      person("person_id"),
      {
        provisional: ["H-525", "H-1584"],
        note: "data_rights_case unless it belongs to a serious incident; built as serious_incident until the table has a per-row class",
      },
    ),
    entry("disclosure_item", classes("serious_incident"), { closedAt: PARENT }, person(null), {
      parent: parentIs("disclosure_request", "request_id"),
    }),

    entry("outbreak", classes("serious_incident"), { closedAt: col("closed_at") }, NO_SUBJECT),
    entry(
      "outbreak_case",
      byValue("case_type", {
        resident: ["care_record"],
        staff: ["outbreak_staff_case"],
        staff_unnamed: ["outbreak_staff_case"],
      }),
      { careEnded: careEndedOf("person_id"), closedAt: PARENT },
      person("person_id"),
      {
        parent: parentIs("outbreak", "outbreak_id"),
        otherSubjects: [staff("tenant_user_id")],
        provisional: ["H-767", "H-1560"],
        note: "Deleted for now: clearing the people (H-1560) needs the case_type check relaxed first",
      },
    ),

    entry(
      "speak_up_concern",
      rowClass("retention_class", "speak_up_concern"),
      { closedAt: col("closed_at") },
      NO_SUBJECT,
      { note: "Restricted silo: reporters are in speak_up_reporter" },
    ),
    speakUpChild("speak_up_message", "author_tenant_user_id"),
    speakUpChild("speak_up_reporter", "tenant_user_id"),
    speakUpChild("speak_up_case_member", "tenant_user_id"),
  ],
};
