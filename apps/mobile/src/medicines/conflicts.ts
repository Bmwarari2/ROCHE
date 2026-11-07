/**
 * Conflict review on the phone (Phase 2 slice 70; medicines.md 15.4; HZ-004): when two phones
 * recorded the same dose, the API keeps the second as a conflict and the nurse in charge decides.
 * Online only: the conflicts are read from and resolved through the API (`GET` and `POST
 * /v1/medicine-administration-conflicts`), never stored on the phone. On the phone the nurse may
 * say the same dose was sent twice (`first_stands`) or that it was given twice (`both_given`, which
 * raises a medication incident); a correction of the MAR is made on the web. Pure apart from the
 * injected fetch.
 */
import type { FetchLike } from "../auth/http";
import { DEVICE_HEADER, TENANT_HEADER } from "../sync/connector";

export interface ConflictRecord {
  /** Who recorded it (the member's id). */
  readonly by: string | null;
  readonly outcome: string;
  readonly quantity: number | null;
  readonly unitCode: string | null;
  readonly givenAt: string | null;
}

export interface ConflictView {
  readonly id: string;
  readonly personId: string;
  readonly entryId: string;
  readonly dueAt: string;
  readonly standing: ConflictRecord;
  readonly uploaded: ConflictRecord;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function recordOf(v: unknown): ConflictRecord | null {
  if (!isRecord(v) || typeof v.outcome !== "string") return null;
  const amount = isRecord(v.amount) ? v.amount : null;
  const by =
    typeof v.uploadedBy === "string"
      ? v.uploadedBy
      : isRecord(v.recorded) && typeof v.recorded.id === "string"
        ? v.recorded.id
        : null;
  return {
    by,
    outcome: v.outcome,
    quantity: typeof amount?.quantity === "number" ? amount.quantity : null,
    unitCode: typeof amount?.unitCode === "string" ? amount.unitCode : null,
    givenAt: typeof v.givenAt === "string" ? v.givenAt : null,
  };
}

/** The open conflicts in the API's answer; anything unreadable is left out and counted. */
export function parseConflicts(body: unknown): { conflicts: ConflictView[]; unreadable: number } {
  const list = isRecord(body) && Array.isArray(body.conflicts) ? body.conflicts : [];
  const conflicts: ConflictView[] = [];
  let unreadable = 0;
  for (const c of list) {
    const standing = isRecord(c) ? recordOf(c.standing) : null;
    const uploaded = isRecord(c) ? recordOf(c.uploaded) : null;
    if (
      !isRecord(c) ||
      typeof c.id !== "string" ||
      typeof c.personId !== "string" ||
      typeof c.entryId !== "string" ||
      typeof c.dueAt !== "string" ||
      !standing ||
      !uploaded ||
      c.resolution !== null
    ) {
      unreadable += isRecord(c) && c.resolution !== null && c.resolution !== undefined ? 0 : 1;
      continue;
    }
    conflicts.push({
      id: c.id,
      personId: c.personId,
      entryId: c.entryId,
      dueAt: c.dueAt,
      standing,
      uploaded,
    });
  }
  return { conflicts, unreadable };
}

/**
 * Whether the two records say the same thing. A resend from one phone is never a conflict (it
 * keeps its id), so even matching records may be two doses: the screen says what matches and who
 * recorded each, never which is likely (clinical review of slice 70, H3).
 */
export function sameDose(c: ConflictView): boolean {
  return c.standing.outcome === c.uploaded.outcome && c.standing.quantity === c.uploaded.quantity;
}

export function sameRecorder(c: ConflictView): boolean {
  return c.standing.by !== null && c.standing.by === c.uploaded.by;
}

export interface ApiOptions {
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly token: string;
  readonly tenantId: string;
  readonly deviceId: string;
}

const headers = (o: ApiOptions) => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  Authorization: `Bearer ${o.token}`,
  [TENANT_HEADER]: o.tenantId,
  [DEVICE_HEADER]: o.deviceId,
});

export async function fetchConflicts(
  o: ApiOptions,
  locationId: string,
): Promise<{ conflicts: ConflictView[]; unreadable: number } | null> {
  try {
    const r = await o.fetch(
      `${o.apiUrl}/v1/medicine-administration-conflicts?locationId=${encodeURIComponent(locationId)}`,
      { method: "GET", headers: headers(o), credentials: "omit" },
    );
    return r.ok ? parseConflicts(await r.json()) : null;
  } catch {
    return null;
  }
}

export type ResolveOutcome = "first_stands" | "both_given";

export async function resolveConflict(
  o: ApiOptions,
  conflictId: string,
  outcome: ResolveOutcome,
  note: string,
): Promise<{ readonly ok: boolean; readonly detail: string | null }> {
  try {
    const r = await o.fetch(
      `${o.apiUrl}/v1/medicine-administration-conflicts/${encodeURIComponent(conflictId)}/resolve`,
      {
        method: "POST",
        headers: headers(o),
        credentials: "omit",
        body: JSON.stringify({ outcome, correctionId: null, note: note.trim() }),
      },
    );
    if (r.ok) return { ok: true, detail: null };
    const body = (await r.json().catch(() => null)) as { detail?: unknown } | null;
    return { ok: false, detail: typeof body?.detail === "string" ? body.detail : null };
  } catch {
    return { ok: false, detail: null };
  }
}

/**
 * Whether the nurse in charge may decide a conflict on the phone: a controlled drug's decision
 * needs a fresh step-up the phone does not ask for, so it is decided on the web (lead's batch 5
 * review, 2). A medicine the phone does not hold is treated as a controlled drug.
 */
export function decidableOnPhone(
  medicine: { readonly cd_schedule: string | null } | undefined,
): boolean {
  // Any schedule, even an empty one, counts as a controlled drug (slice 70 clinical review, L6).
  return medicine !== undefined && medicine.cd_schedule == null;
}

/** Why a conflict waits for the web, in the words the screen chooses between. */
export function notOnPhoneReason(
  medicine: { readonly cd_schedule: string | null } | undefined,
): "cd" | "missing" {
  return medicine === undefined ? "missing" : "cd";
}
