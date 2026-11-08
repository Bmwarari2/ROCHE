/**
 * Retention registry: the quality context (retention sweeps plan, slice 3). Audits from
 * completion (quality_audit; provisional, H-1558); evidence packs as their own class; read-and-sign
 * records with training; organisation documents that name their authors under the organisation's
 * own policy (organisation_document, never offered until it sets a period).
 */

import {
  asLinked,
  childOf,
  classes,
  col,
  entry,
  NO_SUBJECT,
  PARENT,
  parentIs,
  person,
  type RegistryContext,
  staff,
} from "./registry";

const packChild = (table: string) => childOf(table, "evidence_pack", "pack_id", NO_SUBJECT);

export const QUALITY_REGISTRY: RegistryContext = {
  context: "quality",
  entries: [
    entry("audit_record", classes("quality_audit"), { closedAt: col("completed_at") }, NO_SUBJECT, {
      provisional: ["H-1558", "H-1560"],
      note: "Deleted for now: keeping the anonymous audit (H-1560) needs started_by made nullable first",
    }),
    entry("audit_action", classes("quality_audit"), { closedAt: PARENT }, staff("owner_id"), {
      parent: parentIs("audit_record", "audit_id"),
      provisional: ["H-1558"],
    }),
    entry("evidence_link", asLinked("record_type", "record_id"), {}, NO_SUBJECT, {
      provisional: ["H-1558"],
      note: "The class of the record it links, as document_signature",
    }),
    entry(
      "evidence_pack",
      classes("evidence_pack"),
      { createdAt: col("composed_at") },
      person("person_ids"),
      {
        note: "Names its recipient and the staff it shows (staff_names)",
      },
    ),
    packChild("evidence_pack_item"),
    packChild("evidence_pack_link"),
    {
      ...packChild("evidence_pack_bundle"),
      note: "Its content is cleared when the link ends (evidence-bundle-sweep); the row stays as proof",
    },
    entry(
      "policy_signature",
      classes("training_record"),
      { createdAt: col("signed_at") },
      staff("signer_id"),
    ),
    ...(["policy_version", "statement_of_purpose_version"] as const).map((table) =>
      entry(table, classes("organisation_document"), {}, NO_SUBJECT, {
        note: "Organisation material naming its authors and approvers",
      }),
    ),
  ],
};
