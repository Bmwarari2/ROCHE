import { StatusChip } from "@harbour/ui";
import { EyeOff, TriangleAlert, UserCheck } from "lucide-react";
import { Notice } from "@/components/care/Notice";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  type CovertRecord,
  covertChip,
  prnNext,
  type RoundDose,
  type RoundPrn,
  type SelfAdministration,
} from "@/lib/medicine-round";

/**
 * What the round shows beside a medicine (slice 53; medicines.md section 16), the same on the
 * home's round, a person's round and the page that records a dose: the entry's status, a clock
 * change, the covert record and the self-administration level (H-1354), and for a when-required
 * medicine when it was last given, the 24-hour total in the entry's unit and when the next may be
 * given (HZ-004). Every status is an icon and words, never colour alone.
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const when = (iso: string) => formatDateTime(iso) ?? "";

/** An entry that may not be given, or that carries a notice, said in its own words. */
export function EntryStatusNotice({
  status,
}: {
  readonly status: {
    readonly words: string;
    readonly mayGive: boolean;
    readonly notice: string | null;
  };
}) {
  if (status.mayGive && !status.notice) return null;
  return (
    <Notice
      tone="warning"
      icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
      title={status.words}
    >
      {status.notice}
    </Notice>
  );
}

/** A clock change on the dose's day: what happens to this dose (HZ-009). */
export function ClockChange({
  dose,
}: {
  readonly dose: Pick<RoundDose, "clockChange" | "dueAt" | "time">;
}) {
  if (!dose.clockChange) return null;
  return (
    <p className="m-0 font-semibold">
      {dose.clockChange === "time_skipped"
        ? t("medicines.round.clockSkipped", { at: when(dose.dueAt) })
        : t("medicines.round.clockRepeated", { time: dose.time })}
    </p>
  );
}

/** The dose's own notices, as the API words them. */
export function DoseNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <ul className="m-0 flex flex-col gap-1 pl-5">
      {notices.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

/** The covert record for the medicine: status, how it is given and the pharmacist's advice. */
export function CovertBeside({ record }: { readonly record: CovertRecord | null }) {
  if (!record) return null;
  const chip = covertChip(record);
  return (
    <div className="flex flex-col gap-1 rounded-input border border-border p-2">
      <p className="m-0 flex flex-wrap items-center gap-2">
        <EyeOff {...icon} />
        <span className="font-semibold">{t("medicines.round.covert.title")}</span>
        <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
      </p>
      <p className="m-0">{t("medicines.round.covert.method", { method: record.method })}</p>
      <p className="m-0">
        {t("medicines.round.covert.advice", { advice: record.pharmacistAdvice })}
      </p>
    </div>
  );
}

/** Where self-administration stands for the medicine, when it has been assessed (H-1354). */
export function SelfAdminBeside({ item }: { readonly item: SelfAdministration | null }) {
  if (!item) return null;
  return (
    <p className="m-0 flex flex-wrap items-center gap-2">
      <UserCheck {...icon} />
      <span className="font-semibold">{t("medicines.round.selfAdmin.title")}</span>
      <span>
        {item.level
          ? t("medicines.round.selfAdmin.level", { level: item.level, status: item.statusWords })
          : item.statusWords}
      </span>
    </p>
  );
}

/** When last given, the 24-hour total against the maximum in the entry's unit, and when next. */
export function PrnFigures({
  prn,
  unit,
}: {
  readonly prn: RoundPrn;
  /** The entry's dose unit, so the total reads as an amount, never a count of doses. */
  readonly unit: string | null;
}) {
  const next = prnNext(prn);
  // The total is an amount in the entry's unit; without the unit it is not shown, never as a count.
  const total =
    unit === null
      ? null
      : prn.maxPer24Hours === null
        ? t("medicines.round.prn24NoMax", { count: prn.givenInLast24Hours, unit })
        : t("medicines.round.prn24Max", {
            count: prn.givenInLast24Hours,
            max: prn.maxPer24Hours,
            unit,
          });
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      <dt className="font-semibold">{t("medicines.round.prnLast")}</dt>
      <dd className="m-0">
        {prn.lastGiven
          ? prn.lastGiven.synced
            ? when(prn.lastGiven.at)
            : t("medicines.round.prnUnsynced", { at: when(prn.lastGiven.at) })
          : t("medicines.round.notGiven")}
      </dd>
      {total ? (
        <>
          <dt className="font-semibold">{t("medicines.round.prn24")}</dt>
          <dd className="m-0">{total}</dd>
        </>
      ) : null}
      <dt className="font-semibold">{t("medicines.round.prnNext")}</dt>
      <dd className="m-0 font-semibold">
        {next.kind === "maximum_reached"
          ? t("medicines.round.prnMaximumReached")
          : next.kind === "at"
            ? t("medicines.round.prnNextAt", { at: when(next.at) })
            : t("medicines.round.prnNextNow")}
      </dd>
    </dl>
  );
}
