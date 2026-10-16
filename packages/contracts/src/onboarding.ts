import { z } from "zod";

/**
 * The organisation's onboarding checklist (PLAT-018; platform-completions.md rules 26 and 27).
 * Every item is worked out from state; where a person must decide (a setting, a retention class,
 * the staff file option, the DCB0160 assessment) the decision is a record with who and when.
 */

const isoDateTime = z.iso.datetime({ offset: true });

export const OnboardingItem = z
  .object({
    key: z.string(),
    title: z.string(),
    requiredForGoLive: z.boolean(),
    /** The in-app guide's key. */
    guide: z.string(),
    done: z.boolean(),
    /** Plain English, from the same state. */
    reason: z.string(),
    /** Ids or keys still outstanding. */
    outstanding: z.array(z.string()),
    /** For people readiness: each person still outstanding and what they lack. */
    people: z
      .array(
        z.object({
          personId: z.uuid(),
          gaps: z.array(
            z.enum([
              "photo",
              "allergy_status",
              "resuscitation",
              "communication_needs",
              "iddsi_levels",
            ]),
          ),
        }),
      )
      .optional(),
  })
  .meta({ id: "OnboardingItem" });

export const OnboardingChecklist = z
  .object({
    items: z.array(OnboardingItem),
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    readyForGoLive: z.boolean(),
    blockers: z.array(z.string()),
    /** Harbour's safety case for this release, which the DCB0160 assessment must cover. */
    currentSafetyCaseVersion: z.string(),
    staffFileOption: z.enum(["staff_file.after_leaving", "staff_file.to_75th_birthday"]).nullable(),
    /** The organisation record's change counter, sent back to choose the staff file option. */
    version: z.number().int(),
  })
  .meta({ id: "OnboardingChecklist" });
export type OnboardingChecklist = z.infer<typeof OnboardingChecklist>;

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
