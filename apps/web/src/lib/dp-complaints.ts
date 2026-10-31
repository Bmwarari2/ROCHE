import type { paths } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import type { Chip } from "./breaches";
import { COMPLAINTS_PAGE } from "./data-rights";
import { formatDate } from "./format";
import { addDays } from "./uk-time";

/**
 * The data protection complaints screens (PLAT-022; platform.md rule 25;
 * data-protection-complaints.md). Pure, unit tested. The clocks are the API's, from the rate
 * table (`dp_complaint.*`) and the bank holidays, worked out each time they are read: the screen
 * says them in words and never works out a due date itself.
 */

export type Complaint =
  paths["/v1/data-protection/complaints/{id}"]["get"]["responses"][200]["content"]["application/json"];
export type ComplaintList =
  paths["/v1/data-protection/complaints"]["get"]["responses"][200]["content"]["application/json"];

export const complaintPath = (id: string) => `${COMPLAINTS_PAGE}/${id}`;

export const COMPLAINT_CHANNELS = [
  "form",
  "email",
  "letter",
  "phone",
  "in_person",
  "forwarded_by_thapsus",
  "other",
] as const satisfies readonly Complaint["channel"][];

export const COMPLAINANT_KINDS = [
  "person_supported",
  "representative",
  "family",
  "staff",
  "other",
] as const satisfies readonly Complaint["complainantKind"][];

export const COMPLAINT_ABOUT = [
  "access",
  "accuracy",
  "sharing",
  "security",
  "retention",
  "other",
] as const satisfies readonly Complaint["about"][];

/**
 * The acknowledgement clock in words, with its chip: acknowledge by the day the duty sets,
 * overdue since the day after, acknowledged on a day, or acknowledged late. A complaint received
 * before the duty began has no statutory day: the organisation's own target is said instead.
 */
export function acknowledgementWords(
  c: Pick<Complaint, "acknowledgedOn" | "clock">,
  t: Translator,
): Chip {
  const due = formatDate(c.clock.acknowledgeDueOn) ?? "";
  const on = formatDate(c.acknowledgedOn) ?? "";
  switch (c.clock.acknowledgement) {
    case "due":
      return { status: "due", label: t("dataRights.complaint.ack.due", { date: due }) };
    case "overdue":
      return {
        status: "overdue",
        label: t("dataRights.complaint.ack.overdue", {
          date: formatDate(addDays(c.clock.acknowledgeDueOn ?? "", 1)) ?? due,
        }),
      };
    case "done":
      return { status: "done", label: t("dataRights.complaint.ack.done", { date: on }) };
    case "done_late":
      return { status: "done", label: t("dataRights.complaint.ack.late", { date: on }) };
    case "not_applicable":
      return {
        status: "due",
        label: t("dataRights.complaint.ack.target", {
          date: formatDate(c.clock.acknowledgeTargetOn) ?? "",
        }),
      };
    default:
      return { status: "overdue", label: t("dataRights.complaint.ack.unknown") };
  }
}

/** The next update to the complainant in words: due by a day, overdue since it, or closed. */
export function updateWords(c: Pick<Complaint, "clock" | "closedOn">, t: Translator): Chip {
  const date = formatDate(c.clock.nextUpdateDueOn) ?? "";
  switch (c.clock.update) {
    case "due":
      return { status: "due", label: t("dataRights.complaint.update.due", { date }) };
    case "overdue":
      return { status: "overdue", label: t("dataRights.complaint.update.overdue", { date }) };
    case "closed":
      return {
        status: "done",
        label: t("dataRights.complaint.update.closed", { date: formatDate(c.closedOn) ?? "" }),
      };
    default:
      return { status: "overdue", label: t("dataRights.complaint.ack.unknown") };
  }
}

/** The forms the detail page offers, each only while it applies; the API checks every rule again. */
export function complaintForms(c: Pick<Complaint, "status" | "acknowledgedOn">): {
  readonly acknowledge: boolean;
  readonly contact: boolean;
  readonly close: boolean;
} {
  const open = c.status === "open";
  return {
    acknowledge: open && c.acknowledgedOn === null,
    contact: open,
    close: open && c.acknowledgedOn !== null,
  };
}

/** The shortest outcome the API takes when closing (checkComplaintClosure: an outcome recorded). */
export const OUTCOME_MIN = 20;
