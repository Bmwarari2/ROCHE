import type { HospitalTransferOut, TransferPack } from "@harbour/contracts";
import { checkTransferPackHandover, MIN_INCOMPLETE_PACK_REASON_LENGTH } from "@harbour/domain";

/**
 * Helpers for the hospital tab (people.md rule 10 and section 6a; PEOP-009; HZ-001, HZ-023). The
 * pack is the API's, assembled by `assembleHospitalTransferPack`; the screen only puts it in order
 * and in words. It never reads a section's content to decide anything: the PDF prints it.
 */

export type PackSection = TransferPack["sections"][number];
export type PackAttention = NonNullable<TransferPack["attention"]>[number];

export { MIN_INCOMPLETE_PACK_REASON_LENGTH };

/** The pack's sections in the order to read them: safety-critical ones not recorded first. */
export function sectionsInOrder(pack: Pick<TransferPack, "sections">): PackSection[] {
  const rank = (s: PackSection) =>
    s.critical && s.status === "not_recorded"
      ? 0
      : s.status === "not_recorded"
        ? 1
        : s.critical
          ? 2
          : 3;
  // A stable sort keeps the pack's own order within each group.
  return pack.sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => rank(a.section) - rank(b.section) || a.index - b.index)
    .map(({ section }) => section);
}

/** Who the pack is about, from the pack itself, so the screen shows what will print (HZ-001). */
export interface PackIdentity {
  readonly givenName: string;
  readonly familyName: string;
  readonly preferredName: string | null;
  readonly dateOfBirth: string | null;
  readonly nhsNumber: string | null;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/**
 * The pack's identity, or null when the pack is not this person's (its own id, or the identity's,
 * differs from the record open on the screen) or has no name: then the screen shows no pack and
 * says so, rather than risk a pack for the wrong person (HZ-001).
 */
export function packIdentity(
  pack: Pick<TransferPack, "personId" | "identity">,
  personId: string,
): PackIdentity | null {
  const identity = pack.identity;
  if (pack.personId !== personId || identity.personId !== personId) return null;
  const givenName = str(identity.givenName);
  const familyName = str(identity.familyName);
  if (!givenName || !familyName) return null;
  return {
    givenName,
    familyName,
    preferredName: str(identity.preferredName),
    dateOfBirth: str(identity.dateOfBirth),
    nhsNumber: str(identity.nhsNumber),
  };
}

/**
 * Whether recording the hand-over needs the named acknowledgement and a reason: exactly when the
 * domain's own rule refuses it without one (a safety-critical section not recorded, or records
 * that disagree; HZ-023).
 */
export function needsAcknowledgement(
  transfer: Pick<HospitalTransferOut, "missingCritical" | "pack">,
): boolean {
  // The API's strings are the domain's keys and codes; the rule reads only `acknowledge` and the
  // count of missing sections, so the cast changes nothing it decides.
  type HandoverPack = Parameters<typeof checkTransferPackHandover>[0];
  const check = checkTransferPackHandover(
    {
      complete: transfer.pack.complete,
      missingCritical: transfer.missingCritical as HandoverPack["missingCritical"],
      attention: (transfer.pack.attention ?? []) as HandoverPack["attention"],
    },
    null,
  );
  return !check.ok;
}

/** Whether an acknowledgement reason is long enough for the domain's rule. */
export function reasonLongEnough(reason: string): boolean {
  return reason.trim().length >= MIN_INCOMPLETE_PACK_REASON_LENGTH;
}

/** The transfer the person is away on (not yet returned), newest first in the API's list. */
export function openTransfer<T extends Pick<HospitalTransferOut, "returnedAt">>(
  items: readonly T[],
): T | null {
  return items.find((item) => item.returnedAt === null) ?? null;
}

/** Return checks still to do, in the API's order. */
export function checksToDo(
  transfer: Pick<HospitalTransferOut, "returnChecks">,
): HospitalTransferOut["returnChecks"] {
  return transfer.returnChecks.filter((check) => check.doneAt === null);
}
