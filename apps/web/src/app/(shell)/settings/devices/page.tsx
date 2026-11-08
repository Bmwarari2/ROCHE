import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Smartphone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DeviceFacts } from "@/components/devices/DeviceFacts";
import { DeviceStateChip } from "@/components/devices/DeviceStateChip";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { devicesShown, groupDevices } from "@/lib/care-devices";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("devices.title") };

/**
 * Care mode phones (care.md section 6, Device integrity part 2; HZ-040, HZ-006): each phone staff
 * have used here, who used it, when it was last seen, the entries it last reported waiting, and
 * whether it is withdrawn, with a link to withdraw a lost one. Holders of `platform.device.read`;
 * the API narrows the list to the staff they manage.
 */
export default async function DevicesPage() {
  const { me } = await getShellContext();
  const title = t("devices.title");
  if (!devicesShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/devices", { params: { query: {} } });
  if (!listed.data) failWith(listed.error, listed.response, "/settings/devices");
  const devices = groupDevices(listed.data.items);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("devices.description")} />
      <Card as="section" title={t("devices.list.title")} headingLevel={2}>
        {devices.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<Smartphone size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("devices.list.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {devices.map((d) => (
              <li key={d.deviceId} className="flex flex-col gap-1 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link
                    href={`/settings/devices/${d.deviceId}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("devices.name", { shortId: d.shortId })}
                  </Link>
                </h3>
                <DeviceFacts device={d} />
                <p className="m-0">
                  <DeviceStateChip device={d} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
