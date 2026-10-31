import type { TransferPack } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { formatDate, formatDateTime, formatNhsNumber } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { type PackIdentity, sectionsInOrder } from "@/lib/transfer-pack";

/**
 * What a transfer pack holds, as the first page of the PDF puts it (people.md rule 10; HZ-001,
 * HZ-023): who it is about, from the pack itself; each safety-critical section not recorded,
 * first and in words; what needs checking; then every section with when it was last updated. The
 * content of each section is printed in the PDF and never interpreted here.
 */
export function TransferPackView({
  pack,
  identity,
  preview = false,
}: {
  readonly pack: TransferPack;
  readonly identity: PackIdentity;
  /** A pack as it would be made now: it is made again when the person is sent (HZ-002). */
  readonly preview?: boolean;
}) {
  const missing = pack.missingCritical.length;
  const attention = pack.attention ?? [];
  return (
    <div className="flex flex-col gap-4" data-transfer-pack="">
      <section aria-labelledby="pack-identity" className="flex flex-col gap-2">
        <h4 id="pack-identity" className="m-0 text-body font-semibold">
          {t("people.transfer.identityTitle")}
        </h4>
        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
          <dt className="text-text-secondary">{t("people.transfer.name")}</dt>
          <dd className="m-0 font-semibold" data-pack-name="">
            {personNames(identity).full}
          </dd>
          {identity.preferredName ? (
            <>
              <dt className="text-text-secondary">{t("people.transfer.preferredName")}</dt>
              <dd className="m-0">{identity.preferredName}</dd>
            </>
          ) : null}
          <dt className="text-text-secondary">{t("people.transfer.dateOfBirth")}</dt>
          <dd className="m-0" data-pack-dob="">
            {identity.dateOfBirth
              ? (formatDate(identity.dateOfBirth) ?? identity.dateOfBirth)
              : t("common.notRecorded")}
          </dd>
          <dt className="text-text-secondary">{t("people.transfer.nhsNumber")}</dt>
          <dd className="m-0" data-pack-nhs="">
            {formatNhsNumber(identity.nhsNumber) ?? t("common.notRecorded")}
          </dd>
        </dl>
        <p className="m-0 text-body-dense" data-pack-made="">
          {t("people.transfer.madeAt", { dateTime: formatDateTime(pack.generatedAt) ?? "" })}
          {preview ? ` ${t("people.transfer.madeAgain")}` : ""}
        </p>
      </section>
      {missing > 0 ? (
        <p className="m-0 flex items-start gap-2 font-semibold" data-pack-missing="">
          <TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5" />
          <span>{t("people.transfer.missing", { count: missing })}</span>
        </p>
      ) : pack.complete ? (
        <p className="m-0 flex items-start gap-2">
          <CircleCheck size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5" />
          <span>{t("people.transfer.complete")}</span>
        </p>
      ) : (
        // Never a tick while something is missing or needs checking (HZ-023).
        <p className="m-0 flex items-start gap-2 font-semibold" data-pack-not-complete="">
          <TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5" />
          <span>{t("people.transfer.notComplete")}</span>
        </p>
      )}
      {attention.length > 0 ? (
        <section aria-labelledby="pack-attention" className="flex flex-col gap-2">
          <h4 id="pack-attention" className="m-0 text-body font-semibold">
            {t("people.transfer.attentionTitle")}
          </h4>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-6">
            {attention.map((item) => (
              <li key={`${item.key}-${item.code}`} data-pack-attention={item.code}>
                {item.onDate
                  ? t("people.transfer.attentionOn", {
                      message: t("people.transfer.attention", { code: item.code }),
                      date: formatDate(item.onDate) ?? item.onDate,
                    })
                  : t("people.transfer.attention", { code: item.code })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="pack-sections" className="flex flex-col gap-2">
        <h4 id="pack-sections" className="m-0 text-body font-semibold">
          {t("people.transfer.sectionsTitle")}
        </h4>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {sectionsInOrder(pack).map((section) => (
            <li
              key={section.key}
              className="flex flex-wrap items-center gap-2"
              data-pack-section={section.key}
              data-pack-status={section.status}
            >
              <span className="font-semibold">
                {t("people.transfer.section", { key: section.key })}
              </span>
              {section.status === "not_recorded" ? (
                <StatusChip
                  status={section.critical ? "overdue" : "notRecorded"}
                  label={t("people.transfer.notRecorded")}
                  icon={TriangleAlert}
                />
              ) : (
                <StatusChip
                  status="done"
                  label={t("people.transfer.included")}
                  icon={CircleCheck}
                />
              )}
              {section.critical ? (
                <span className="text-body-dense">{t("people.transfer.safetyCritical")}</span>
              ) : null}
              {section.asOf ? (
                <span className="text-body-dense text-text-secondary">
                  {t("people.transfer.asOf", { dateTime: formatDateTime(section.asOf) ?? "" })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
