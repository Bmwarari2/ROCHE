import { Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { Thermometer } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordReadingForm } from "@/components/medicines/stock/LocationStockForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  locationStockHref,
  mayRecordTemperature,
  rangeWords,
  readingChip,
  stockShown,
  storageHref,
} from "@/lib/medicine-stock";

type Params = Promise<{ locationId: string; storageId: string }>;

export const metadata: Metadata = { title: t("medicines.stock.reading.title") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * A fridge's or room's temperature readings (slice 55; MEDS-008; medicines.md section 15 rule 8;
 * HZ-132): the last 100, newest first, each with its state as an icon and a word, the range that
 * applied (the rate table's, as the API stored it), the thermometer's minimum and maximum, and
 * whether a task was raised. Whether a reading is out of range is the database's decision. Nothing
 * here says whether the medicines can be used: the task asks the pharmacist.
 */
export default async function StorageReadingsPage({ params }: { readonly params: Params }) {
  const { locationId, storageId } = await params;
  if (!isUuid(locationId) || !isUuid(storageId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.stock.reading.title");
  if (!stockShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const [storage, readings] = await Promise.all([
    api.GET("/v1/locations/{id}/medicine-storage", { params: { path: { id: locationId } } }),
    api.GET("/v1/medicine-storage/{id}/readings", { params: { path: { id: storageId } } }),
  ]);
  for (const read of [storage, readings]) {
    if (problemCode(read.error) === "not_found") notFound();
    if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  }
  if (!storage.data) failWith(storage.error, storage.response, storageHref(locationId, storageId));
  if (!readings.data) {
    failWith(readings.error, readings.response, storageHref(locationId, storageId));
  }
  const place = storage.data.items.find((s) => s.id === storageId);
  if (!place) notFound();
  const when = (iso: string) => formatDateTime(iso) ?? "";

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={t("medicines.stock.storage.open", { name: place.name, kind: place.kind })}
        description={t("medicines.stock.reading.intro")}
      />
      {mayRecordTemperature(me.permissions) ? (
        <Card as="section" title={t("medicines.stock.reading.record")} headingLevel={2}>
          <RecordReadingForm locationId={locationId} storageId={storageId} />
        </Card>
      ) : null}
      <Card as="section" title={t("medicines.stock.reading.listTitle")} headingLevel={2}>
        {readings.data.items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<Thermometer {...iconProps} />}
            title={t("medicines.stock.reading.none")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {readings.data.items.map((r) => {
              const chip = readingChip(r, t);
              return (
                <li key={r.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
                    <span className="font-semibold">
                      {t("medicines.stock.reading.value", { celsius: r.celsius })}
                    </span>
                    <span>{when(r.recordedAt)}</span>
                  </p>
                  <p className="m-0">{rangeWords(r, t)}</p>
                  {r.minCelsius !== null ? (
                    <p className="m-0">
                      {t("medicines.stock.reading.minSince", { celsius: r.minCelsius })}
                    </p>
                  ) : null}
                  {r.maxCelsius !== null ? (
                    <p className="m-0">
                      {t("medicines.stock.reading.maxSince", { celsius: r.maxCelsius })}
                    </p>
                  ) : null}
                  {r.outOfRange && r.taskId ? (
                    <p className="m-0">{t("medicines.stock.reading.taskRaised")}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <p className="m-0">
        <Link
          href={locationStockHref(locationId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("medicines.stock.back")}
        </Link>
      </p>
    </div>
  );
}
