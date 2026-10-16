import { createHash, randomBytes } from "node:crypto";
import {
  auditEvent,
  careNote,
  type evidencePack,
  evidencePackBundle,
  evidencePackItem,
  evidencePackLink,
  incident,
  location,
  observation,
  person,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  EVIDENCE_LINK_MAX_CODE_ATTEMPTS,
  EVIDENCE_PACK_RATE_KEYS,
  EVIDENCE_REDACTION_TEXT,
  type EvidenceField,
  type EvidenceFieldKind,
  type EvidenceItem,
  type EvidencePackPolicy,
  type EvidencePackRequest,
  type EvidenceRecordType,
  type EvidenceRedactionReason,
  formatUkDateTime,
  resolveEvidencePackPolicy,
} from "@harbour/domain";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { publish } from "../outbox";
import { rateRows } from "./rates";

/**
 * Inspector evidence packs (quality.md rules 1 to 10; QUAL-003; ADR-0050; hazard HZ-050): the
 * records a pack may take, read in the caller's own scope; the pack's request for the domain; its
 * manifest; the link token; and deleting the bundle when the link ends. The bundle holds only the
 * values the pack shows (`minimiseEvidenceField`), by item and field key; withheld values are never
 * written anywhere.
 */

export type EvidencePackRow = typeof evidencePack.$inferSelect;
type ItemRow = typeof evidencePackItem.$inferSelect;
/** The shown values: `{ [itemId]: { [fieldKey]: value } }`. */
export type BundleContent = Record<string, Record<string, string>>;

/** What the database stores of a field: its outcome without its value (migration 0057). */
export interface StoredField {
  readonly key: string;
  readonly label: string;
  readonly kind: EvidenceFieldKind;
  readonly outcome: "included" | "redacted" | "withheld";
  readonly reason?: EvidenceRedactionReason;
  readonly redactedBy?: string;
}

// ------------------------------------------------------------------------------------------------
// Records a pack can take, read under the caller's scope (anything else reads as not found)
// ------------------------------------------------------------------------------------------------

/** Why: a key or label longer than the database allows is cut, never refused (keys are ours). */
const MAX_LABEL = 80;

const words = (code: string) => code.replaceAll("_", " ");
const yesNo = (value: boolean) => (value ? "Yes" : "No");

interface PersonNames {
  readonly id: string;
  readonly display: string;
  readonly names: readonly string[];
  readonly room: string | null;
  readonly nhsNumber: string | null;
  readonly dateOfBirth: string | null;
}

async function peopleNamed(tx: Transaction, ids: readonly string[]): Promise<PersonNames[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: person.id,
      given: person.givenName,
      family: person.familyName,
      preferred: person.preferredName,
      room: person.roomLabel,
      nhs: person.nhsNumber,
      dob: person.dateOfBirth,
    })
    .from(person)
    .where(inArray(person.id, [...ids]));
  return rows.map((r) => ({
    id: r.id,
    display: `${r.preferred ?? r.given} ${r.family}`,
    names: [`${r.given} ${r.family}`, r.given, r.family, ...(r.preferred ? [r.preferred] : [])],
    room: r.room,
    nhsNumber: r.nhs,
    dateOfBirth: r.dob,
  }));
}

async function staffName(tx: Transaction, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await tx
    .select({ name: tenantUser.displayName })
    .from(tenantUser)
    .where(eq(tenantUser.id, id));
  return row?.name ?? null;
}

const field = (
  key: string,
  label: string,
  value: string,
  extra: Partial<Pick<EvidenceField, "aboutPersonId" | "role">> = {},
): EvidenceField => ({
  key,
  label: label.slice(0, MAX_LABEL),
  value,
  aboutPersonId: extra.aboutPersonId ?? null,
  role: extra.role ?? null,
  redacted: null,
});

/** The person's own fields: their name and room (care content) and identifiers (withheld). */
function personFields(p: PersonNames): EvidenceField[] {
  const about = { aboutPersonId: p.id };
  return [
    field("person_name", "Person", p.display, about),
    ...(p.room ? [field("room", "Room", p.room, about)] : []),
    ...(p.nhsNumber ? [field("nhs_number", "NHS number", p.nhsNumber, about)] : []),
    ...(p.dateOfBirth ? [field("date_of_birth", "Date of birth", p.dateOfBirth, about)] : []),
  ];
}

/** Whether an append-only entry has been corrected by a later one (the pack takes the latest). */
async function corrected(
  tx: Transaction,
  table: typeof careNote | typeof observation,
  id: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(eq(table.supersedesId, id))
    .limit(1);
  return row !== undefined;
}

/** Strings that are codes (enums), not typed text: only these go in a chart's values. */
const CODE = /^[a-z0-9_]{1,40}$/;

interface Loaded {
  readonly item: Omit<EvidenceItem, "id" | "qualityStatementIds">;
  /** A correction exists: add the correction instead. */
  readonly corrected: boolean;
}

async function loadCareNote(tx: Transaction, id: string): Promise<Loaded | null> {
  const [row] = await tx.select().from(careNote).where(eq(careNote.id, id));
  if (!row) return null;
  const [p] = await peopleNamed(tx, [row.personId]);
  if (!p) return null;
  const author = await staffName(tx, row.createdBy);
  return {
    corrected: await corrected(tx, careNote, id),
    item: {
      recordType: "care_note",
      recordId: row.id,
      recordVersion: 1,
      locationId: row.locationId,
      occurredAt: row.occurredAt,
      title: `Care note: ${words(row.category)}`,
      aboutPersonIds: [row.personId],
      namedPeople: [{ personId: p.id, names: p.names }],
      restricted: false,
      fields: [
        ...personFields(p),
        field("category", "Category", words(row.category)),
        ...(row.tags.length > 0 ? [field("tags", "Tags", row.tags.map(words).join(", "))] : []),
        field("occurred_at", "When", formatUkDateTime(row.occurredAt)),
        field("late_entry", "Written late", yesNo(row.lateEntry)),
        field("text", "Note", row.body),
        ...(author ? [field("author", "Written by", author)] : []),
      ],
    },
  };
}

async function loadObservation(tx: Transaction, id: string): Promise<Loaded | null> {
  const [row] = await tx.select().from(observation).where(eq(observation.id, id));
  if (!row) return null;
  const [p] = await peopleNamed(tx, [row.personId]);
  if (!p) return null;
  const recordedBy = await staffName(tx, row.createdBy);
  // Numbers, yes or no and codes are the reading; any other text was typed, so is free text.
  const values: string[] = [];
  const typed: string[] = [];
  for (const [key, value] of Object.entries(row.values as Record<string, unknown>)) {
    if (key === "chart" || value === null || value === undefined) continue;
    if (typeof value === "number") values.push(`${words(key)} ${value}`);
    else if (typeof value === "boolean") values.push(`${words(key)} ${yesNo(value)}`);
    else if (typeof value === "string" && CODE.test(value))
      values.push(`${words(key)} ${words(value)}`);
    else if (typeof value === "string") typed.push(`${words(key)}: ${value}`);
  }
  const about = { aboutPersonId: p.id };
  return {
    corrected: await corrected(tx, observation, id),
    item: {
      recordType: "observation",
      recordId: row.id,
      recordVersion: 1,
      locationId: row.locationId,
      occurredAt: row.occurredAt,
      title: `Observation: ${words(row.chart)}`,
      aboutPersonIds: [row.personId],
      namedPeople: [{ personId: p.id, names: p.names }],
      restricted: false,
      fields: [
        ...personFields(p),
        field("chart", "Chart", words(row.chart)),
        field("occurred_at", "When", formatUkDateTime(row.occurredAt)),
        ...(values.length > 0 ? [field("values", "Reading", values.join("; "), about)] : []),
        ...(typed.length > 0 ? [field("comment", "Comment", typed.join("; "))] : []),
        ...(recordedBy ? [field("recorded_by", "Recorded by", recordedBy)] : []),
      ],
    },
  };
}

async function loadIncident(tx: Transaction, id: string): Promise<Loaded | null> {
  const [row] = await tx
    .select()
    .from(incident)
    .where(and(eq(incident.id, id), isNull(incident.deletedAt)));
  if (!row) return null;
  const people = await peopleNamed(tx, row.personIds);
  // Every person on it must be readable in this scope, or it reads as not found.
  if (people.length !== row.personIds.length) return null;
  const [place] = await tx
    .select({ name: location.name })
    .from(location)
    .where(eq(location.id, row.locationId));
  const [raisedBy, closedBy] = [
    await staffName(tx, row.raisedBy),
    await staffName(tx, row.closedBy),
  ];
  // Care content is about one person; with several it is withheld as not clearly about one.
  const only = people.length === 1 ? people[0] : undefined;
  const about = { aboutPersonId: only?.id ?? null };
  return {
    corrected: false,
    item: {
      recordType: "incident",
      recordId: row.id,
      recordVersion: row.version,
      locationId: row.locationId,
      occurredAt: row.occurredAt,
      title: `Incident: ${words(row.type)}`,
      aboutPersonIds: row.personIds,
      namedPeople: people.map((p) => ({ personId: p.id, names: p.names })),
      restricted: false,
      fields: [
        ...(only ? personFields(only) : []),
        field("type", "Type", words(row.type)),
        field("occurred_at", "When", formatUkDateTime(row.occurredAt)),
        ...(place ? [field("location", "Location", place.name)] : []),
        ...(row.severity ? [field("severity", "Severity", words(row.severity))] : []),
        ...(row.harmGrade ? [field("harm_grade", "Harm", words(row.harmGrade), about)] : []),
        field("description", "What happened", row.description),
        ...(row.immediateActions
          ? [field("immediate_actions", "Immediate actions", row.immediateActions)]
          : []),
        field(
          "emergency_services",
          "Emergency services called",
          yesNo(row.emergencyServicesCalled),
        ),
        ...(row.familyInformedWho
          ? [field("family_informed", "Family told", row.familyInformedWho, { role: "relative" })]
          : []),
        ...(raisedBy ? [field("raised_by", "Raised by", raisedBy)] : []),
        ...(closedBy ? [field("closed_by", "Closed by", closedBy)] : []),
      ],
    },
  };
}

const LOADERS: Readonly<
  Partial<Record<EvidenceRecordType, (tx: Transaction, id: string) => Promise<Loaded | null>>>
> = { care_note: loadCareNote, observation: loadObservation, incident: loadIncident };

/** A record as an evidence item, read in the caller's scope; null when it is not there for them. */
export async function loadEvidenceRecord(
  tx: Transaction,
  recordType: EvidenceRecordType,
  recordId: string,
  qualityStatementIds: readonly string[],
): Promise<{ readonly item: EvidenceItem; readonly corrected: boolean } | null> {
  const loader = LOADERS[recordType];
  const loaded = loader ? await loader(tx, recordId) : null;
  if (!loaded) return null;
  return {
    corrected: loaded.corrected,
    item: { ...loaded.item, id: recordId, qualityStatementIds },
  };
}

// ------------------------------------------------------------------------------------------------
// The pack: its request, items, manifest and bundle
// ------------------------------------------------------------------------------------------------

/** The pack as the domain's request (`composeEvidencePack`). */
export function packRequest(row: EvidencePackRow): EvidencePackRequest {
  return {
    packId: row.id,
    recipient: {
      name: row.recipientName,
      organisation: row.recipientOrganisation,
      email: row.recipientEmail,
    },
    purpose: row.purpose,
    from: row.dateFrom,
    to: row.dateTo,
    locationIds: row.locationIds,
    qualityStatementIds: row.qualityStatementIds,
    peopleInScope: row.personIds,
    staffNames: row.staffNames as "role_only" | "include",
    composedBy: row.composedBy,
    composedAt: row.composedAt,
  };
}

/** The items in force: every row no later row supersedes. */
export async function currentItems(tx: Transaction, packId: string): Promise<ItemRow[]> {
  const rows = await tx
    .select()
    .from(evidencePackItem)
    .where(eq(evidencePackItem.packId, packId))
    .orderBy(asc(evidencePackItem.occurredAt), asc(evidencePackItem.id));
  const replaced = new Set(rows.map((r) => r.supersedesId).filter((id) => id !== null));
  return rows.filter((r) => !replaced.has(r.id));
}

export async function bundleOf(
  tx: Transaction,
  packId: string,
): Promise<{ readonly content: BundleContent | null; readonly exists: boolean }> {
  const [row] = await tx
    .select({ content: evidencePackBundle.content })
    .from(evidencePackBundle)
    .where(eq(evidencePackBundle.packId, packId));
  return { content: (row?.content as BundleContent | null) ?? null, exists: row !== undefined };
}

/** Writes the shown values (a draft only; the database refuses otherwise). */
export async function writeBundle(
  tx: Transaction,
  packId: string,
  content: BundleContent,
  exists: boolean,
): Promise<void> {
  if (exists) {
    await tx
      .update(evidencePackBundle)
      .set({ content })
      .where(eq(evidencePackBundle.packId, packId));
  } else {
    await tx.insert(evidencePackBundle).values({ packId, content });
  }
}

export async function contributorsOf(tx: Transaction, packId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ ids: string[] | null }>(
    sql`SELECT app.evidence_pack_contributors(${packId}) AS ids`,
  );
  return rows[0]?.ids ?? [];
}

/** The link and code policy in force for the organisation (tenant policy defaults). */
export async function evidencePackPolicy(
  tx: Transaction,
  tenantId: string,
  at: Date,
): Promise<EvidencePackPolicy> {
  return resolveEvidencePackPolicy(
    await rateRows(tx, Object.values(EVIDENCE_PACK_RATE_KEYS)),
    "england",
    at.toISOString().slice(0, 10),
    tenantId,
  );
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function packSummary(row: EvidencePackRow) {
  return {
    id: row.id,
    state: row.state as "draft" | "released" | "revoked" | "discarded",
    recipientName: row.recipientName,
    recipientOrganisation: row.recipientOrganisation,
    purpose: row.purpose,
    from: row.dateFrom,
    to: row.dateTo,
    locationIds: row.locationIds,
    composedBy: row.composedBy,
    composedAt: row.composedAt.toISOString(),
    releasedAt: iso(row.releasedAt),
    revokedAt: iso(row.revokedAt),
    discardedAt: iso(row.discardedAt),
    version: row.version,
  };
}

/** The internal manifest: the request, the current items with their outcomes, links and values. */
export async function packDetail(tx: Transaction, row: EvidencePackRow) {
  const items = await currentItems(tx, row.id);
  const bundle = await bundleOf(tx, row.id);
  const links = await tx
    .select()
    .from(evidencePackLink)
    .where(eq(evidencePackLink.packId, row.id))
    .orderBy(asc(evidencePackLink.issuedAt));
  const coverage: Record<string, number> = {};
  for (const item of items) {
    if (item.exclusionReason !== null) continue;
    for (const s of item.qualityStatementIds) coverage[s] = (coverage[s] ?? 0) + 1;
  }
  return {
    ...packSummary(row),
    recipientEmail: row.recipientEmail,
    personIds: row.personIds,
    qualityStatementIds: row.qualityStatementIds,
    staffNames: row.staffNames as "role_only" | "include",
    watermark: row.watermark,
    contributorIds: await contributorsOf(tx, row.id),
    releasedBy: row.releasedBy,
    revokedBy: row.revokedBy,
    revocationReason: row.revocationReason,
    discardedBy: row.discardedBy,
    discardReason: row.discardReason,
    items: items.map((item) => ({
      id: item.id,
      recordType: item.recordType,
      recordId: item.recordId,
      recordVersion: item.recordVersion,
      title: item.title,
      occurredAt: item.occurredAt.toISOString(),
      qualityStatementIds: item.qualityStatementIds,
      exclusionReason: item.exclusionReason,
      fields: (item.fields as StoredField[]).map((f) => ({
        key: f.key,
        label: f.label,
        kind: f.kind,
        outcome: f.outcome,
        reason: f.reason ?? null,
        reasonText: f.reason ? EVIDENCE_REDACTION_TEXT[f.reason] : null,
        redactedBy: f.redactedBy ?? null,
        value: f.outcome === "withheld" ? null : (bundle.content?.[item.id]?.[f.key] ?? null),
      })),
    })),
    coverage,
    links: links.map((k) => ({
      id: k.id,
      issuedAt: k.issuedAt.toISOString(),
      issuedBy: k.issuedBy,
      expiresAt: k.expiresAt.toISOString(),
      replacesLinkId: k.replacesLinkId,
      revokedAt: iso(k.revokedAt),
      revocationReason: k.revocationReason,
      failedCodeAttempts: k.failedCodeAttempts,
      locked: k.failedCodeAttempts >= EVIDENCE_LINK_MAX_CODE_ATTEMPTS,
      lastOpenedAt: iso(k.lastOpenedAt),
    })),
    bundleDeleted: bundle.exists && bundle.content === null,
  };
}

// ------------------------------------------------------------------------------------------------
// The link token (ADR-0050 rule 1)
// ------------------------------------------------------------------------------------------------

/** Why: 256 bits from the platform's cryptographic random source (ADR-0050 rule 1). */
const TOKEN_BYTES = 32;

/** SHA-256 (hex) of the token's UTF-8 bytes: all the database ever holds of it. */
export function evidenceLinkTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newEvidenceLinkToken(): { readonly token: string; readonly hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: evidenceLinkTokenHash(token) };
}

// ------------------------------------------------------------------------------------------------
// Deleting the bundle (rule 10, `evidencePackBundleDeletable`)
// ------------------------------------------------------------------------------------------------

export const BUNDLE_DELETED = "quality.evidence_pack.bundle_deleted";

export type BundleDeletionReason = "link_ended" | "pack_revoked" | "pack_discarded";

/** Clears the shown values for good; true when there were any. The database checks the reason. */
export async function deleteBundle(
  tx: Transaction,
  packId: string,
  reason: BundleDeletionReason,
): Promise<boolean> {
  const deleted = await tx
    .update(evidencePackBundle)
    .set({ content: null, deletedAt: sql`now()`, deletionReason: reason })
    .where(and(eq(evidencePackBundle.packId, packId), isNull(evidencePackBundle.deletedAt)))
    .returning({ id: evidencePackBundle.id });
  return deleted.length > 0;
}

/**
 * The sweep (#56 security review round 1, Medium): every bundle whose pack is revoked or
 * discarded, or released with no link still open (each revoked or expired), is deleted, audited
 * as the system with the reason. The routes delete at once on revoke and discard; this catches
 * expiry, which no request marks, and anything a failed request left.
 */
export async function sweepEvidenceBundles(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const due = await tx.execute<{ pack_id: string; reason: BundleDeletionReason }>(sql`
    SELECT b.pack_id,
           CASE p.state WHEN 'revoked' THEN 'pack_revoked'
                        WHEN 'discarded' THEN 'pack_discarded'
                        ELSE 'link_ended' END AS reason
      FROM evidence_pack_bundle b JOIN evidence_pack p ON p.id = b.pack_id
     WHERE b.deleted_at IS NULL
       AND (p.state IN ('revoked', 'discarded')
         OR (p.state = 'released'
             AND EXISTS (SELECT 1 FROM evidence_pack_link k WHERE k.pack_id = p.id)
             AND NOT EXISTS (SELECT 1 FROM evidence_pack_link k
                              WHERE k.pack_id = p.id AND k.revoked_at IS NULL
                                AND k.expires_at > ${now.toISOString()}::timestamptz)))
     ORDER BY b.pack_id
     LIMIT 500`);
  let deleted = 0;
  for (const { pack_id: packId, reason } of due.rows) {
    if (!(await deleteBundle(tx, packId, reason))) continue;
    deleted++;
    await tx.insert(auditEvent).values({
      tenantId,
      action: BUNDLE_DELETED,
      resourceType: "evidence_pack",
      resourceId: packId,
      reason,
      scope: { job: "evidence-bundle-sweep" },
    });
  }
  return deleted;
}

/** Announces a pack's release or revocation to the other modules (ids only). */
export function publishPackEvent(
  tx: Transaction,
  packId: string,
  type: "quality.evidence_pack.released" | "quality.evidence_pack.revoked",
  payload: Record<string, string | null>,
) {
  return publish(tx, {
    context: "quality",
    aggregateType: "evidence_pack",
    aggregateId: packId,
    type,
    payload: { packId, ...payload },
  });
}
