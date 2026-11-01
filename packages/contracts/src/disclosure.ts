import { z } from "zod";
import { DsarNotSearched } from "./data-rights";

/**
 * Disclosure requests (SAFE-016; safety.md section 12): coroner, Safeguarding Adults Review,
 * Domestic Homicide Review, police, solicitor and Access to Health Records Act requests about one
 * person. Collection and review reuse the DSAR collector (ADR-0090); the approver is never the
 * person who logged the request; the pack is issued with step-up and stored as sent.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const ukDate = z.iso.date();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Versioned = { expectedVersion: z.number().int().min(1) };

export const DisclosureType = z
  .enum([
    "coroner",
    "safeguarding_adults_review",
    "domestic_homicide_review",
    "police",
    "solicitor",
    "access_to_health_records",
  ])
  .meta({ id: "DisclosureType" });

export const DisclosureState = z
  .enum(["requested", "prepared", "approved", "released", "refused", "withdrawn"])
  .meta({ id: "DisclosureState" });

export const DisclosureRequestOut = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    type: DisclosureType,
    legalBasis: z.string(),
    requester: z.object({
      name: z.string(),
      organisation: z.string(),
      reference: z.string().nullable(),
    }),
    statedPurpose: z.string().nullable(),
    receivedAt: isoDateTime,
    dueAt: isoDateTime.nullable(),
    state: DisclosureState,
    loggedBy: uuid.nullable(),
    preparedBy: uuid.nullable(),
    decidedBy: uuid.nullable(),
    decidedAt: isoDateTime.nullable(),
    reason: z.string().nullable(),
    releasedBy: uuid.nullable(),
    releasedAt: isoDateTime.nullable(),
    packSha256: z.string().nullable(),
    collectedAt: isoDateTime.nullable(),
    notSearched: z.array(DsarNotSearched),
    items: z.object({
      total: z.number().int(),
      pending: z.number().int(),
      disclose: z.number().int(),
      redact: z.number().int(),
      withhold: z.number().int(),
    }),
    /** Coroner: a Regulation 28 report, when the response is due (rate table) and when it was sent. */
    prevention: z
      .object({
        reportOn: ukDate,
        responseDueOn: ukDate,
        respondedOn: ukDate.nullable(),
        state: z.enum(["due", "overdue", "responded"]),
      })
      .nullable(),
    version: z.number().int(),
  })
  .meta({ id: "DisclosureRequest" });

export const DisclosureLog = z
  .object({ items: z.array(DisclosureRequestOut), truncated: z.boolean() })
  .meta({ id: "DisclosureLog" });

export const LogDisclosureRequest = z
  .object({
    personId: uuid,
    type: DisclosureType,
    requester: z.object({
      name: text(1, 200),
      organisation: text(1, 200),
      reference: text(1, 100).nullable().optional(),
    }),
    statedPurpose: text(3, 2000).nullable().optional(),
    receivedAt: isoDateTime,
  })
  .meta({ id: "LogDisclosureRequest" });

export const DisclosureVersioned = z.object(Versioned).meta({ id: "DisclosureVersioned" });

export const DecideDisclosure = z
  .object({
    ...Versioned,
    decision: z.enum(["approve", "refuse"]),
    reason: text(3, 2000).nullable().optional(),
  })
  .meta({ id: "DecideDisclosure" });

export const WithdrawDisclosure = z
  .object({ ...Versioned, reason: text(3, 2000) })
  .meta({ id: "WithdrawDisclosure" });

export const RecordPreventionReport = z
  .object({ ...Versioned, reportOn: ukDate, respondedOn: ukDate.nullable().optional() })
  .meta({ id: "RecordPreventionReport" });

export const DisclosureCollectResult = z
  .object({
    added: z.number().int(),
    total: z.number().int(),
    tablesSearched: z.number().int(),
    notSearched: z.array(DsarNotSearched),
    truncated: z.boolean(),
  })
  .meta({ id: "DisclosureCollectResult" });

export const DisclosureItemOut = z
  .object({
    id: uuid,
    tableName: z.string(),
    recordId: z.string(),
    decision: z.enum(["pending", "disclose", "redact", "withhold"]),
    redactedFields: z.array(z.string()),
    reason: z.string().nullable(),
    reviewedBy: uuid.nullable(),
    reviewedAt: isoDateTime.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "DisclosureItem" });

export const DisclosureItemList = z
  .object({ items: z.array(DisclosureItemOut), total: z.number().int() })
  .meta({ id: "DisclosureItemList" });

export const DisclosureItemDetail = DisclosureItemOut.extend({
  record: z.record(z.string(), z.unknown()).nullable(),
  contentSha256: z.string().nullable(),
  highlights: z.array(
    z.object({
      field: z.string(),
      name: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    }),
  ),
}).meta({ id: "DisclosureItemDetail" });

export const DisclosurePack = z
  .object({
    requestId: uuid,
    type: DisclosureType,
    legalBasis: z.string(),
    generatedAt: isoDateTime,
    /** In date order: the chronology for a review. */
    records: z.array(
      z.object({
        table: z.string(),
        recordId: z.string(),
        when: z.string().nullable(),
        fields: z.record(z.string(), z.unknown()),
      }),
    ),
    redactedCount: z.number().int(),
    withheldCount: z.number().int(),
    notSearched: z.array(DsarNotSearched),
    sha256: z.string(),
  })
  .meta({ id: "DisclosurePack" });
