import { Card, PageHeader, StatusChip } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { protocolMembers } from "@/components/medicines/homely/load-members";
import { ProtocolForm } from "@/components/medicines/homely/ProtocolForm";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  changeProtocolHref,
  mayManageProtocols,
  protocolChip,
  protocolDefaults,
  protocolsHref,
} from "@/lib/homely-remedies";
import { t } from "@/lib/i18n";

type Params = Promise<{ locationId: string; protocolId: string }>;

export const metadata: Metadata = { title: t("medicines.homely.changeTitle") };

/**
 * Changing a homely remedy protocol (slice 55; medicines.md section 15.3; HZ-120): every figure as
 * it stands, a new reason, and the version read, so a change made meanwhile is not overwritten.
 * Doses already given keep the version they were checked against. A withdrawn protocol is closed.
 */
export default async function ChangeProtocolPage({ params }: { readonly params: Params }) {
  const { locationId, protocolId } = await params;
  if (!isUuid(locationId) || !isUuid(protocolId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.homely.changeTitle");
  if (!mayManageProtocols(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const read = await api.GET("/v1/locations/{id}/homely-remedies", {
    params: { path: { id: locationId } },
  });
  if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, changeProtocolHref(locationId, protocolId));
  const protocol = read.data.items.find((p) => p.id === protocolId);
  if (!protocol) notFound();
  const chip = protocolChip(protocol);
  const back = (
    <p className="m-0">
      <Link
        href={protocolsHref(locationId)}
        className="inline-flex min-h-target items-center underline"
      >
        {t("medicines.homely.back")}
      </Link>
    </p>
  );
  const header = (
    <PageHeader
      eyebrow={location.name}
      title={title}
      description={t("medicines.homely.changeIntro", { product: protocol.productName })}
    />
  );
  if (protocol.status === "withdrawn") {
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-6">
        {header}
        <p className="m-0 flex flex-wrap items-center gap-2">
          <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
          {t("medicines.homely.closed")}
        </p>
        {back}
      </div>
    );
  }
  const members = await protocolMembers(me, locationId, protocol.authorisedMemberIds);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      {header}
      <p className="m-0">
        <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
      </p>
      <Card as="section" title={protocol.productName} headingLevel={2}>
        <ProtocolForm
          locationId={locationId}
          members={members}
          change={{ protocolId, version: protocol.version }}
          defaults={protocolDefaults(protocol)}
          named={protocol.authorisedMemberIds}
        />
      </Card>
      {back}
    </div>
  );
}
