import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeviceStateChip } from "@/components/devices/DeviceStateChip";
import { DeviceWithdrawForm } from "@/components/devices/DeviceWithdrawForm";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { devicesShown, groupDevices, mayWithdrawDevices } from "@/lib/care-devices";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

type Params = Promise<{ deviceId: string }>;

export const metadata: Metadata = { title: t("devices.withdraw.title") };

/**
 * One Care mode phone (HZ-040, HZ-006): who used it, what it last reported waiting, and, for a
 * holder of `platform.device.revoke`, the form to withdraw it. A phone the API does not list for
 * this person reads as not found.
 */
export default async function DevicePage({ params }: { readonly params: Params }) {
  const { deviceId: raw } = await params;
  if (!isUuid(raw)) notFound();
  const deviceId = raw.toLowerCase();
  const { me } = await getShellContext();
  if (!devicesShown(me.permissions)) return <SafetyForbidden title={t("devices.title")} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/devices", { params: { query: {} } });
  if (!listed.data) failWith(listed.error, listed.response, `/settings/devices/${deviceId}`);
  const device = groupDevices(listed.data.items).find((d) => d.deviceId === deviceId);
  if (!device) notFound();
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("devices.title")}
        title={t("devices.name", { shortId: device.shortId })}
        description={t("devices.withdraw.description")}
      />
      <Card as="section" title={t("devices.detail.title")} headingLevel={2}>
        <div className="flex flex-col gap-2">
          <p className="m-0">
            <DeviceStateChip device={device} />
          </p>
          <p className="m-0">
            {t("devices.usedBy", { names: device.members.map((m) => m.name).join(", ") })}
          </p>
          <p className="m-0">
            {t("devices.firstSeen", { when: formatDateTime(device.firstSeenAt) ?? "" })}
          </p>
          <p className="m-0">
            {t("devices.lastSeen", { when: formatDateTime(device.lastSeenAt) ?? "" })}
          </p>
          <p className="m-0">
            {device.lastReportedAt
              ? t("devices.waiting", {
                  count: device.entriesWaiting,
                  when: formatDateTime(device.lastReportedAt) ?? "",
                })
              : t("devices.neverReported")}
          </p>
          {device.revokedAt ? (
            <p className="m-0">
              {t("devices.withdrawnOn", {
                when: formatDateTime(device.revokedAt) ?? "",
                reason: device.revocationReason ?? "other",
              })}
            </p>
          ) : null}
        </div>
      </Card>
      {device.revokedAt ? null : mayWithdrawDevices(me.permissions) ? (
        <Card as="section" title={t("devices.withdraw.cardTitle")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0">{t("devices.withdraw.about")}</p>
            <DeviceWithdrawForm deviceId={device.deviceId} entriesWaiting={device.entriesWaiting} />
          </div>
        </Card>
      ) : (
        <p className="m-0">{t("devices.withdraw.notAllowed")}</p>
      )}
      <p className="m-0">
        <Link href="/settings/devices" className="inline-flex min-h-target items-center underline">
          {t("devices.back")}
        </Link>
      </p>
    </div>
  );
}
