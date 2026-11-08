/**
 * Retention registry: the integrations context (retention sweeps plan, slice 3). The Thapsus-HR
 * link follows the staff file, and its pay rates and units are pay calculation inputs too
 * (rota_and_timesheet; longest wins; provisional, H-1558); a scanned MAR chart's extraction is part
 * of the person's medicines record (care_record).
 */

import {
  childOf,
  classes,
  col,
  entry,
  leavingOf,
  lookup,
  NO_SUBJECT,
  parentIs,
  payPeriodEnd,
  personRecord,
  type RegistryContext,
  staff,
  staffFileRecord,
} from "./registry";

const hrPeriodEnd = lookup("hr_pay_period", "hr_pay_period_id", "ends_on");

export const INTEGRATIONS_REGISTRY: RegistryContext = {
  context: "integrations",
  entries: [
    staffFileRecord("hr_person_link", "staff_profile_id", "staff_profile", {
      provisional: ["H-1558"],
    }),
    entry(
      "hr_pay_rate",
      classes("staff_file", "rota_and_timesheet"),
      {
        employmentEndedAt: leavingOf("staff_profile_id", "staff_profile"),
        createdAt: col("effective_from"),
        periodEndsAt: payPeriodEnd(col("effective_from")),
      },
      staff("staff_profile_id"),
      { provisional: ["H-1558", "H-1584"] },
    ),
    entry(
      "hr_pay_unit",
      classes("staff_file", "rota_and_timesheet"),
      {
        employmentEndedAt: leavingOf("member_id", "tenant_user"),
        createdAt: hrPeriodEnd,
        periodEndsAt: hrPeriodEnd,
      },
      staff("member_id"),
      { parent: parentIs("pay_run", "run_id"), provisional: ["H-1558"] },
    ),
    entry(
      "integration_inbound",
      {
        kind: "not_retained",
        removedBy:
          "no sweep yet: an inbound message is staged until resolved into the record it becomes",
        rateKey: null,
        at: col("resolved_at"),
      },
      {},
      NO_SUBJECT,
      { provisional: ["DPO decision"] },
    ),
    childOf("notification_delivery", "notification", "notification_id", staff(null)),
    personRecord("ocr_extraction", "care_record"),
    personRecord("ocr_field", "care_record", {
      parent: parentIs("ocr_extraction", "extraction_id"),
    }),
  ],
};
