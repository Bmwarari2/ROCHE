import { z } from "zod";

/**
 * The organisation's onboarding decisions (PLAT-018; platform-completions.md rules 26 and 27).
 * Where a person must decide (a setting, a retention class, the staff file option, the DCB0160
 * assessment) the decision is a record with who and when.
 */

const isoDateTime = z.iso.datetime({ offset: true });

export const SettingDecision = z
  .object({ rateKey: z.string().min(1).max(200), kind: z.enum(["accepted", "set"]) })
  .meta({ id: "SettingDecision" });
export type SettingDecision = z.infer<typeof SettingDecision>;

export const RetentionDecision = z
  .object({
    recordClass: z.string().min(1).max(200),
    kind: z.enum(["accepted", "lengthened", "period_set", "not_used"]),
  })
  .meta({ id: "RetentionDecision" });
export type RetentionDecision = z.infer<typeof RetentionDecision>;

export const StaffFileOptionChoice = z
  .object({
    option: z.enum(["staff_file.after_leaving", "staff_file.to_75th_birthday"]),
    expectedVersion: z.number().int(),
  })
  .meta({ id: "StaffFileOptionChoice" });

export const StaffFileOptionChosen = z
  .object({
    option: z.enum(["staff_file.after_leaving", "staff_file.to_75th_birthday"]),
    version: z.number().int(),
  })
  .meta({ id: "StaffFileOptionChosen" });

export const Dcb0160Recording = z
  .object({
    /** The safety case version the assessment covers, as the recorder read it. */
    safetyCaseVersion: z.string().trim().min(1).max(40),
  })
  .meta({ id: "Dcb0160Recording" });

export const OnboardingDecisionRecorded = z
  .object({ id: z.uuid(), decidedAt: isoDateTime })
  .meta({ id: "OnboardingDecisionRecorded" });
