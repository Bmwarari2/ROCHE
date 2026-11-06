import { Button, Card, PageHeader, SelectField, TextArea } from "@harbour/ui";
import { Info } from "lucide-react";
import type { Metadata } from "next";
import { Notice } from "@/components/care/Notice";
import { CopyFigures } from "@/components/quality/CopyFigures";
import { QualityChip } from "@/components/quality/QualityChip";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import {
  areaName,
  dashboardShown,
  PIR_AREAS,
  pirAnswer,
  pirChip,
  pirCopyText,
} from "@/lib/quality-dashboard";

export const metadata: Metadata = { title: t("quality.pir.title") };

type Search = Promise<{ location?: string | string[] }>;

const cell = "py-2 pe-4 text-start align-top";

/**
 * The Provider Information Return figures (QUAL-006; quality.md section 22, rule 43; HZ-129): for
 * one location, the last 12 whole months, each data point by CQC key question, prefilled with its
 * answer and where it comes from, or marked to complete with why. Harbour submits nothing; the
 * figures are given as text to copy into the return, with a button that copies them.
 */
export default async function PirPage({ searchParams }: { searchParams: Search }) {
  const { me, locationId: shellLocation } = await getShellContext();
  const title = t("quality.pir.title");
  const hint = t("quality.pir.forbidden");
  if (!dashboardShown(me.permissions)) return <SafetyForbidden title={title} hint={hint} />;
  const params = await searchParams;
  const asked = typeof params.location === "string" ? params.location : null;
  const location =
    me.locations.find((l) => l.id === asked) ??
    me.locations.find((l) => l.id === shellLocation) ??
    me.locations[0];
  if (!location) return <SafetyForbidden title={title} hint={hint} />;
  const path = "/quality/pir";
  const api = await tenantApi();
  const pir = readOrFail(
    await api.GET("/v1/quality/pir", { params: { query: { locationId: location.id } } }),
    path,
  );
  if (!pir) return <SafetyForbidden title={title} hint={hint} />;
  const from = formatDate(pir.period.from) ?? "";
  const to = formatDate(pir.period.to) ?? "";
  const copyText = pirCopyText(pir.items, { location: location.name, from, to }, t);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.pir.description")} />

      <Notice
        icon={<Info size={20} aria-hidden="true" />}
        title={t("quality.pir.notSubmittedTitle")}
      >
        <p className="m-0">{t("quality.pir.notSubmitted")}</p>
      </Notice>

      <form method="get" action={path} className="flex flex-wrap items-end gap-4">
        <SelectField
          name="location"
          label={t("quality.dashboard.picker.location")}
          defaultValue={location.id}
          options={me.locations.map((l) => ({ value: l.id, label: l.name }))}
          className="w-full min-w-0 max-w-xs"
        />
        <Button type="submit" variant="secondary">
          {t("quality.pir.show")}
        </Button>
      </form>

      <div className="flex flex-col gap-2">
        <h2 className="m-0 text-title font-semibold">
          {t("quality.pir.showing", { location: location.name, from, to })}
        </h2>
        <p className="m-0">{t("quality.pir.period", { from, to })}</p>
        {pir.questionSet.confirmed ? null : (
          <p className="m-0 text-body-dense text-text-secondary">{t("quality.pir.unconfirmed")}</p>
        )}
      </div>

      {PIR_AREAS.map((area) => {
        const items = pir.items.filter((i) => i.area === area);
        if (items.length === 0) return null;
        const name = areaName(area, t);
        return (
          <Card key={area} as="div" title={name} headingLevel={3}>
            <section
              className="overflow-x-auto"
              aria-label={t("quality.pir.scroll", { area: name })}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling table is reached by keyboard (WCAG 2.1.1).
              tabIndex={0}
            >
              <table className="w-full border-collapse text-body-dense">
                <caption className="hb-visually-hidden">{name}</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className={`${cell} font-semibold`}>
                      {t("quality.pir.column.point")}
                    </th>
                    <th scope="col" className={`${cell} font-semibold`}>
                      {t("quality.pir.column.answer")}
                    </th>
                    <th scope="col" className={`${cell} font-semibold`}>
                      {t("quality.pir.column.status")}
                    </th>
                    <th scope="col" className={`${cell} font-semibold`}>
                      {t("quality.pir.column.source")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.key} className="border-b border-border">
                      <th scope="row" className={`${cell} font-normal`}>
                        {t("quality.pir.label", { key: item.key })}
                      </th>
                      <td className={cell}>
                        {item.status === "prefilled" ? (
                          <span className="flex flex-col gap-1">
                            <span className="font-semibold">{pirAnswer(item, t)}</span>
                            {item.records !== null ? (
                              <span className="text-text-secondary">
                                {t("quality.pir.records", { records: item.records })}
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          t("quality.pir.reason", { code: item.reasonCode ?? "no_value" })
                        )}
                      </td>
                      <td className={`${cell} whitespace-nowrap`}>
                        <QualityChip chip={pirChip(item.status, t)} />
                      </td>
                      <td className={cell}>{t("quality.pir.source", { key: item.key })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </Card>
        );
      })}

      <Card as="section" title={t("quality.pir.copyTitle")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <CopyFigures text={copyText} />
          <TextArea
            name="copy"
            label={t("quality.pir.copyLabel")}
            hint={t("quality.pir.copyHint")}
            readOnly
            spellCheck={false}
            rows={Math.max(4, copyText.split("\n").length + 1)}
            defaultValue={copyText}
          />
        </div>
      </Card>
    </div>
  );
}
