import { formatUkDateTimeWithZone } from "../shared/time";

/**
 * What every printed or exported medicines list taken from the eMAR says about itself (slice 49;
 * HZ-021, HZ-023): when it was produced, and that it is not the live record. It shows and passes
 * on the record; it never says what to give (medical-device boundary).
 */
export function emarSnapshotNotice(producedAt: Date): string {
  return `From the eMAR at ${formatUkDateTimeWithZone(producedAt)}. This is not the live record: check the eMAR, or the paper MAR in use, before giving or holding any medicine.`;
}
