import { z } from "zod";
import { StaffName } from "./staff";

/**
 * The organisation's DPIA and its data protection governance (PLAT-023; platform-completions.md
 * rules 17 to 22). The DPIA is prepared in-app from Harbour's prefill and the organisation's
 * answers, then signed by the named data protection lead, who prepared none of it.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const ukDate = z.iso.date();

export const RiskLevel = z.enum(["low", "medium", "high"]).meta({ id: "RiskLevel" });

export const DataProtectionSettings = z
  .object({
    /** The member named as data protection officer or lead (they sign the DPIA). */
    leadId: uuid.nullable(),
    dpoName: z.string().trim().max(200).nullable(),
    dpoEmail: z.email().max(254).nullable(),
    sector: z.enum(["independent", "public"]),
    privacyNoticeUrl: z
      .url({ protocol: /^https$/ })
      .max(500)
      .nullable(),
    dpaSignedOn: ukDate.nullable(),
    usesDataBeyondDirectCare: z.boolean().nullable(),
    marketingEnabled: z.boolean(),
    aiFreeTextEnabled: z.boolean(),
    aiProvider: z.enum(["bedrock_london", "bedrock_eu", "anthropic", "tenant_own"]).nullable(),
  })
  .meta({ id: "DataProtectionSettings" });
export type DataProtectionSettings = z.infer<typeof DataProtectionSettings>;

export const DpiaVersion = z
  .object({
    id: uuid,
    dpiaVersion: z.number().int().min(1),
    status: z.enum(["draft", "prepared", "signed", "superseded"]),
    prefill: z.record(z.string(), z.unknown()),
    answers: z.record(z.string(), z.record(z.string(), z.string())),
    residualRisk: z.record(z.string(), RiskLevel.nullable()),
    icoReference: z.string().nullable(),
    preparedBy: z.array(StaffName),
    versionSha256: z.string().nullable(),
    preparedAt: isoDateTime.nullable(),
    signedBy: StaffName.nullable(),
    signedAt: isoDateTime.nullable(),
    typedName: z.string().nullable(),
    statement: z.string().nullable(),
    /** The row's change counter, sent back to save (a stale save is refused). */
    version: z.number().int(),
  })
  .meta({ id: "DpiaVersion" });
export type DpiaVersion = z.infer<typeof DpiaVersion>;

export const DpiaOverview = z
  .object({
    state: z.enum(["not_started", "draft", "prepared", "signed", "review_due"]),
    /** Why a signed DPIA is due for review: what is new since, or the yearly review. */
    triggers: z.array(
      z.object({
        kind: z.string(),
        items: z.array(z.string()).optional(),
        dueAt: isoDateTime.optional(),
      }),
    ),
    settings: DataProtectionSettings,
    /** Configuration missing before the DPIA can be signed. */
    missingConfig: z.array(z.string()),
    /** The version being prepared, if any. */
    open: DpiaVersion.nullable(),
    /** The version in force, if any. */
    signed: DpiaVersion.nullable(),
    reviewDueAt: isoDateTime.nullable(),
  })
  .meta({ id: "DpiaOverview" });
export type DpiaOverview = z.infer<typeof DpiaOverview>;

export const SaveDpia = z
  .object({
    /** The open version's `version` as read; omitted to start a new version. */
    expectedVersion: z.number().int().optional(),
    answers: z.record(z.string(), z.record(z.string(), z.string().max(10_000))),
    residualRisk: z.record(z.string(), RiskLevel.nullable()),
    icoReference: z.string().trim().max(100).nullable(),
  })
  .meta({ id: "SaveDpia" });
export type SaveDpia = z.infer<typeof SaveDpia>;

export const PrepareDpia = z
  .object({ expectedVersion: z.number().int() })
  .meta({ id: "PrepareDpia" });

export const SignDpia = z
  .object({
    typedName: z.string().max(120),
    statement: z.string().max(1_000).optional(),
    /** The version's SHA-256 as the signer read it: the signature binds to it. */
    sha256Seen: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .meta({ id: "SignDpia" });
export type SignDpia = z.infer<typeof SignDpia>;
