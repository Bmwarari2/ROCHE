import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Building2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { downtimeNavShown } from "@/lib/downtime";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("operations.downtime.title") };

/**
 * Downtime (OPS-028): goes to the chosen location's page, or asks which location when the shell
 * shows every location. Only the locations the viewer works at are listed.
 */
export default async function DowntimeIndexPage() {
  const { me, locationId } = await getShellContext();
  const title = t("operations.downtime.title");
  if (!downtimeNavShown(me.permissions)) return <SafetyForbidden title={title} />;
  if (locationId) redirect(`/downtime/${locationId}`);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("operations.downtime.chooseLocation")}
      />
      {me.locations.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Building2 size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("operations.downtime.noLocations")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {me.locations.map((location) => (
            <li key={location.id}>
              <Link
                href={`/downtime/${location.id}`}
                className="inline-flex min-h-target items-center underline"
              >
                {location.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
