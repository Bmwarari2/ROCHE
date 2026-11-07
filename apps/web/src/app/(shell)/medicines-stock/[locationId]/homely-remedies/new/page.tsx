import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { protocolMembers } from "@/components/medicines/homely/load-members";
import { ProtocolForm } from "@/components/medicines/homely/ProtocolForm";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { mayManageProtocols, protocolsHref } from "@/lib/homely-remedies";
import { t } from "@/lib/i18n";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = { title: t("medicines.homely.addTitle") };

/**
 * Adding a homely remedy protocol agreed with a GP or pharmacist (slice 55; medicines.md section
 * 15.3; HZ-120), for a medicines manager at the home.
 */
export default async function NewProtocolPage({ params }: { readonly params: Params }) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.homely.addTitle");
  if (!mayManageProtocols(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const members = await protocolMembers(me, locationId, []);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("medicines.homely.addIntro")}
      />
      <Card as="section" title={t("medicines.homely.protocolDetails")} headingLevel={2}>
        <ProtocolForm locationId={locationId} members={members} />
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
