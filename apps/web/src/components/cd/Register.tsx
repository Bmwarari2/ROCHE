import type { components } from "@harbour/contracts/client";
import { StatusChip } from "@harbour/ui";
import {
  flagChip,
  movementChip,
  stockCheckChip,
  withCorrectionsBeside,
} from "@/lib/controlled-drugs";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * A register page's entries and counts (medicines.md section 15 rules 2 and 7), for the screen and
 * the print view alike: each entry with its number on the page, when, the movement as an icon and a
 * word, the quantity, who it came from or went to and the reference, the balance after it as the
 * API recorded it, and who recorded and witnessed it (or why no witness). A correction sits
 * directly under the entry it corrects, which says it was corrected; nothing is struck through or
 * hidden. Nothing here adds up a balance.
 */

type Detail = components["schemas"]["CdPageDetail"];

export function RegisterEntries({ page }: { readonly page: Detail }) {
  const names = new Map(page.people.map((p) => [p.id, p.name]));
  const name = (id: string | null) => (id ? (names.get(id) ?? t("cd.formerMember")) : "");
  const seqOf = new Map(page.entries.map((e) => [e.id, e.seq]));
  const unit = page.unit.name;
  const rows = withCorrectionsBeside(page.entries);
  if (rows.length === 0) return <p className="m-0">{t("cd.noEntries")}</p>;
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {rows.map(({ entry: e, depth }) => {
        const chip = movementChip(e.movement, t);
        return (
          <li
            key={e.id}
            className={`flex flex-col gap-1 border-b border-border pb-3 ${depth > 0 ? "ml-6 border-s-4 ps-3" : ""}`}
          >
            <p className="m-0 flex flex-wrap items-center gap-2">
              <span className="font-semibold">{t("cd.entry.number", { seq: e.seq })}</span>
              <StatusChip status={chip.status} icon={chip.icon} label={chip.label} />
              {e.flags.map((f) => (
                <StatusChip key={f} {...flagChip(f, t)} />
              ))}
            </p>
            {e.correctsId ? (
              <p className="m-0 font-semibold">
                {t("cd.entry.corrects", {
                  seq: seqOf.get(e.correctsId) ?? 0,
                  what: e.corrects ?? "detail",
                })}
              </p>
            ) : null}
            <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-body-dense sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold">{t("cd.entry.when")}</dt>
              <dd className="m-0">{formatDateTime(e.occurredAt)}</dd>
              <dt className="font-semibold">{t("cd.entry.quantity")}</dt>
              <dd className="m-0">{t("cd.amount", { quantity: e.quantity, unit })}</dd>
              <dt className="font-semibold">{t("cd.entry.balanceAfter")}</dt>
              <dd className="m-0 font-semibold">
                {t("cd.amount", { quantity: e.balanceAfter, unit })}
              </dd>
              {e.counterparty ? (
                <>
                  <dt className="font-semibold">{t("cd.entry.counterparty")}</dt>
                  <dd className="m-0">{e.counterparty}</dd>
                </>
              ) : null}
              {e.reference ? (
                <>
                  <dt className="font-semibold">{t("cd.entry.reference")}</dt>
                  <dd className="m-0">{e.reference}</dd>
                </>
              ) : null}
              {e.reason ? (
                <>
                  <dt className="font-semibold">{t("cd.entry.reason")}</dt>
                  <dd className="m-0 whitespace-pre-wrap">{e.reason}</dd>
                </>
              ) : null}
              <dt className="font-semibold">{t("cd.entry.recordedBy")}</dt>
              <dd className="m-0">
                {t("cd.entry.byAt", {
                  name: name(e.recorded.id),
                  when: formatDateTime(e.recorded.at) ?? "",
                })}
              </dd>
              <dt className="font-semibold">{t("cd.entry.witness")}</dt>
              <dd className="m-0">
                {e.witnessId
                  ? name(e.witnessId)
                  : t("cd.entry.noWitness", { reason: e.noWitnessReason ?? "" })}
              </dd>
            </dl>
            {e.correctedBy.length > 0 ? (
              <p className="m-0 text-body-dense font-semibold">
                {t("cd.entry.correctedBy", {
                  seqs: e.correctedBy.map((c) => seqOf.get(c) ?? 0).join(", "),
                  count: e.correctedBy.length,
                })}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function StockChecks({ page }: { readonly page: Detail }) {
  const names = new Map(page.people.map((p) => [p.id, p.name]));
  const name = (id: string | null) => (id ? (names.get(id) ?? t("cd.formerMember")) : "");
  const unit = page.unit.name;
  // The generated type allows null (the schema is shared with `lastStockCheck`); none is sent.
  const checks = page.stockChecks.filter((s): s is NonNullable<typeof s> => s !== null);
  if (checks.length === 0) return <p className="m-0">{t("cd.neverCounted")}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {[...checks].reverse().map((s) => (
        <li key={s.id} className="flex flex-col gap-1 border-b border-border pb-3">
          <p className="m-0 flex flex-wrap items-center gap-2">
            <StatusChip {...stockCheckChip(s)} />
            <span className="text-body-dense">{formatDateTime(s.checked.at)}</span>
          </p>
          <p className="m-0 text-body-dense">
            {t("cd.check.line", {
              counted: s.counted,
              expected: s.expected,
              unit,
              by: name(s.checked.id),
              witness: s.witnessId
                ? name(s.witnessId)
                : t("cd.entry.noWitness", { reason: s.noWitnessReason ?? "" }),
            })}
          </p>
          {s.reason ? (
            <p className="m-0 text-body-dense">{t("cd.check.reasonGiven", { reason: s.reason })}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
