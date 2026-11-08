import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeviceFacts } from "@/components/devices/DeviceFacts";
import { DeviceStateChip } from "@/components/devices/DeviceStateChip";
import { DeviceWithdrawForm } from "@/components/devices/DeviceWithdrawForm";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import {
  type DeviceSummary,
  devicesShown,
  groupDevices,
  mayWithdrawDevices,
} from "@/lib/care-devices";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";

type Params = Promise<{ deviceId: string }>;
type SearchParams = Promise<{ done?: string | string[]; waiting?: string | string[] }>;

/** The phone as this person may see it, or null. */
async function deviceFor(deviceId: string): Promise<DeviceSummary | null> {
  const api = await tenantApi();
  const listed = await api.GET("/v1/devices", { params: { query: {} } });
  if (!listed.data) failWith(listed.error, listed.response, `/settings/devices/${deviceId}`);
  return groupDevices(listed.data.items).find((d) => d.deviceId === deviceId) ?? null;
}

/** Each phone's page has its own title (WCAG 2.4.2). */
export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const { deviceId } = await params;
  if (!isUuid(deviceId)) return { title: t("devices.title") };
  const { me } = await getShellContext();
  if (!devicesShown(me.permissions)) return { title: t("devices.title") };
  const device = await deviceFor(deviceId.toLowerCase());
  return { title: device ? t("devices.name", { shortId: device.shortId }) : t("devices.title") };
}

/**
 * One Care mode phone (HZ-040, HZ-006): who used it, what it last reported waiting, and, for a
 * holder of `platform.device.revoke`, the form to withdraw it. A phone the API does not list for
 * this person reads as not found. After a withdrawal the page opens again at `done`, whose status
 * takes focus.
 */
export default async function DevicePage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { deviceId: raw } = await params;
  if (!isUuid(raw)) notFound();
  const deviceId = raw.toLowerCase();
  const { me } = await getShellContext();
  if (!devicesShown(me.permissions)) return <SafetyForbidden title={t("devices.title")} />;
  const device = await deviceFor(deviceId);
  if (!device) notFound();
  const query = await searchParams;
  const done = query.done === "withdrawn" || query.done === "already" ? query.done : null;
  const waitingNow = Number(typeof query.waiting === "string" ? query.waiting : "0");
  const waiting = Number.isInteger(waitingNow) && waitingNow > 0 ? waitingNow : 0;
  const mayWithdraw = !device.revokedAt && mayWithdrawDevices(me.permissions);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("devices.title")}
        title={t("devices.name", { shortId: device.shortId })}
        description={t("devices.detail.description", {
          state: device.revokedAt ? "withdrawn" : mayWithdraw ? "withdraw" : "view",
        })}
      />
      {done ? (
        <RecordedArrival
          message={t("devices.withdraw.done", { done, count: waiting })}
          param="done"
        />
      ) : null}
      <Card as="section" title={t("devices.detail.title")} headingLevel={2}>
        <div className="flex flex-col gap-2">
          <p className="m-0">
            <DeviceStateChip device={device} />
          </p>
          <DeviceFacts device={device} firstSeen />
        </div>
      </Card>
      {mayWithdraw ? (
        <Card as="section" title={t("devices.withdraw.cardTitle")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0">{t("devices.withdraw.about")}</p>
            <DeviceWithdrawForm
              deviceId={device.deviceId}
              entriesWaiting={device.entriesWaiting}
              reported={device.lastReportedAt !== null}
            />
          </div>
        </Card>
      ) : null}
      <p className="m-0">
        <Link href="/settings/devices" className="inline-flex min-h-target items-center underline">
          {t("devices.back")}
        </Link>
      </p>
    </div>
  );
}
