import { Card, PageHeader, StatusChip } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProtocolSummary } from "@/components/medicines/homely/ProtocolSummary";
import { WithdrawProtocolForm } from "@/components/medicines/homely/WithdrawProtocolForm";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  mayManageProtocols,
  protocolChip,
  protocolsHref,
  withdrawProtocolHref,
} from "@/lib/homely-remedies";
import { t } from "@/lib/i18n";

type Params = Promise<{ locationId: string; protocolId: string }>;

export const metadata: Metadata = { title: t("medicines.homely.withdrawTitle") };

/**
 * Withdrawing a homely remedy protocol with a reason (slice 55; medicines.md section 15.3): the
 * protocol as it stands, what withdrawing it does, and the reason. It is never used again.
 */
export default async function WithdrawProtocolPage({ params }: { readonly params: Params }) {
  const { locationId, protocolId } = await params;
  if (!isUuid(locationId) || !isUuid(protocolId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.homely.withdrawTitle");
  if (!mayManageProtocols(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const read = await api.GET("/v1/locations/{id}/homely-remedies", {
    params: { path: { id: locationId } },
  });
  if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, withdrawProtocolHref(locationId, protocolId));
  const protocol = read.data.items.find((p) => p.id === protocolId);
  if (!protocol) notFound();
  const chip = protocolChip(protocol);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("medicines.homely.withdrawIntro", { product: protocol.productName })}
      />
      <Card as="section" title={protocol.productName} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="m-0">
            <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
          </p>
          <ProtocolSummary protocol={protocol} staff />
          {protocol.status === "withdrawn" ? (
            <p className="m-0">{t("medicines.homely.alreadyWithdrawn")}</p>
          ) : (
            <WithdrawProtocolForm
              locationId={locationId}
              protocolId={protocolId}
              version={protocol.version}
            />
          )}
        </div>
      </Card>
      <p className="m-0">
        <Link
          href={protocolsHref(locationId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("medicines.homely.back")}
        </Link>
      </p>
    </div>
  );
}
