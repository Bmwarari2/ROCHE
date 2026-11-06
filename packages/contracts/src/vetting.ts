import { z } from "zod";
import { StaffName } from "./staff";

/**
 * Identity and vetting adapters (workforce.md section 2e and rule 24; ADR-0094; slice 77). The
 * ports' requests and results are parsed strictly: an adapter's answer with a field the port does
 * not declare is refused, so a DBS certificate's contents can never arrive. Dates are UK dates.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const version = z.number().int().min(1);

export const VettingPort = z
  .enum([
    "workforce.idsp",
    "workforce.dbs_ebulk",
    "workforce.dbs_update_service",
    "workforce.nmc_register",
  ])
  .meta({ id: "VettingPort" });

export const VettingCheckKind = z
  .enum(["idsp_right_to_work", "dbs_application", "dbs_status_check", "nmc_register_check"])
  .meta({ id: "VettingCheckKind" });
export type VettingCheckKind = z.infer<typeof VettingCheckKind>;

export const VettingConsentPurpose = z
  .enum(["dbs_application", "dbs_update_service"])
  .meta({ id: "VettingConsentPurpose" });

export const IdspDocument = z
  .enum(["british_passport", "irish_passport", "irish_passport_card"])
  .meta({ id: "IdspDocument" });

/** A 12-digit DBS certificate number. */
const certificateNumber = z.string().regex(/^\d{12}$/, "A 12-digit certificate number");

// --- The ports' results (strict) ----------------------------------------------------------

export const IdspResult = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("identity_verified"),
    checkedOn: isoDate,
    document: IdspDocument,
  }),
  z.strictObject({ outcome: z.literal("not_verified"), checkedOn: isoDate }),
]);
export const DbsApplicationResult = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("certificate_issued"),
    checkedOn: isoDate,
    issuedOn: isoDate,
    certificateNumber,
    level: z.literal("enhanced_adults_barred"),
    result: z.enum(["clear", "information_disclosed"]),
  }),
  z.strictObject({ outcome: z.literal("withdrawn"), checkedOn: isoDate }),
]);
export const UpdateServiceResult = z.strictObject({
  outcome: z.enum(["no_new_information", "new_information", "details_not_matched"]),
  checkedOn: isoDate,
});
export const NmcRegisterResult = z.strictObject({
  outcome: z.enum(["registered", "registered_with_conditions", "not_registered"]),
  checkedOn: isoDate,
  renewalDueOn: isoDate.nullable(),
});

/** The strict result schema of each check. */
export const VETTING_RESULT_SCHEMAS = {
  idsp_right_to_work: IdspResult,
  dbs_application: DbsApplicationResult,
  dbs_status_check: UpdateServiceResult,
  nmc_register_check: NmcRegisterResult,
} as const;

export const VettingResult = z
  .union([IdspResult, DbsApplicationResult, UpdateServiceResult, NmcRegisterResult])
  .meta({ id: "VettingResult" });

// --- The API ------------------------------------------------------------------------------

export const VettingPortState = z
  .object({ port: VettingPort, on: z.boolean(), provider: z.string().nullable() })
  .meta({ id: "VettingPortState" });
export const VettingPortList = z
  .object({ items: z.array(VettingPortState) })
  .meta({ id: "VettingPortList" });

export const VettingConsent = z
  .object({
    id: uuid,
    version: z.number().int(),
    purpose: VettingConsentPurpose,
    givenOn: isoDate,
    recordedBy: StaffName.nullable(),
    withdrawnOn: isoDate.nullable(),
    withdrawnBy: StaffName.nullable(),
    inForce: z.boolean(),
  })
  .meta({ id: "VettingConsent" });
export type VettingConsent = z.infer<typeof VettingConsent>;

export const VettingCheck = z
  .object({
    id: uuid,
    version: z.number().int(),
    kind: VettingCheckKind,
    provider: z.string(),
    consentId: uuid.nullable(),
    requestedBy: StaffName.nullable(),
    requestedAt: z.iso.datetime({ offset: true }),
    checked: z.object({
      document: IdspDocument.optional(),
      certificateNumber: z.string().optional(),
      pin: z.string().optional(),
    }),
    state: z.enum(["pending", "completed", "failed"]),
    result: VettingResult.nullable(),
    error: z.string().nullable(),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    appliedAt: z.iso.datetime({ offset: true }).nullable(),
    appliedBy: StaffName.nullable(),
    /** Whether applying it would change the file, or why not (workforce.md rule 24). */
    applicable: z.boolean(),
    notApplicableReason: z.string().nullable(),
  })
  .meta({ id: "VettingCheck" });
export type VettingCheck = z.infer<typeof VettingCheck>;

export const StaffFileVetting = z
  .object({
    consents: z.array(VettingConsent),
    checks: z.array(VettingCheck),
    ports: z.array(VettingPortState),
  })
  .meta({ id: "StaffFileVetting" });
export type StaffFileVetting = z.infer<typeof StaffFileVetting>;

export const RecordVettingConsent = z
  .object({ purpose: VettingConsentPurpose, givenOn: isoDate })
  .meta({ id: "RecordVettingConsent" });

export const WithdrawVettingConsent = z
  .object({ expectedVersion: version, withdrawnOn: isoDate })
  .meta({ id: "WithdrawVettingConsent" });

export const StartVettingCheck = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("idsp_right_to_work"), document: IdspDocument }),
    z.object({ kind: z.literal("dbs_application") }),
    z.object({
      kind: z.literal("dbs_status_check"),
      /** The surname as the certificate gives it; sent to the Update Service, never stored. */
      familyName: z.string().trim().min(1).max(80),
    }),
    z.object({ kind: z.literal("nmc_register_check") }),
  ])
  .meta({ id: "StartVettingCheck" });
export type StartVettingCheck = z.infer<typeof StartVettingCheck>;

export const RefreshVettingCheck = z
  .object({ expectedVersion: version })
  .meta({ id: "RefreshVettingCheck" });

export const ApplyVettingCheck = z
  .object({
    expectedVersion: version,
    /** The item's version when it exists. */
    itemExpectedVersion: version.nullable(),
    /**
     * IDSP only: the checker confirms the photograph the provider matched is of the worker in
     * front of them, as the Home Office employer's guide requires.
     */
    identityConfirmed: z.boolean().default(false),
  })
  .meta({ id: "ApplyVettingCheck" });
