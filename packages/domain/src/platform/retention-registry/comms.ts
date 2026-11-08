/**
 * Retention registry: the comms context (retention sweeps plan, slice 3). What families are
 * shown is part of the person's care record; a letter carries its own class (serious_incident for
 * a letter about a serious incident, else care_record; migration 0059).
 */

import {
  careEndedOf,
  classes,
  entry,
  lookup,
  NO_SUBJECT,
  parentIs,
  person,
  personRecord,
  type RegistryContext,
  rowClass,
  staff,
} from "./registry";

export const COMMS_REGISTRY: RegistryContext = {
  context: "comms",
  entries: [
    personRecord("family_portal_user", "care_record", { otherSubjects: [staff("tenant_user_id")] }),
    personRecord("feed_item", "care_record"),
    personRecord("feed_item_withdrawal", "care_record", {
      parent: parentIs("feed_item", "feed_item_id"),
    }),
    personRecord("feed_view", "audit_event.care_record", {
      parent: parentIs("feed_item", "feed_item_id"),
    }),
    entry(
      "letter",
      rowClass("retention_class", "serious_incident", "care_record"),
      {
        careEnded: careEndedOf("person_id"),
        closedAt: lookup("incident", "incident_id", "closed_at"),
      },
      person("person_id"),
    ),
    entry("letter_template_version", classes("organisation_document"), {}, NO_SUBJECT, {
      note: "Organisation material naming its authors and approvers",
    }),
  ],
};
