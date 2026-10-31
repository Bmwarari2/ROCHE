import { PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { ComposePackForm } from "@/components/quality/ComposePackForm";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { COMPOSE } from "@/lib/evidence-packs";
import { t } from "@/lib/i18n";
import { getPeopleNames } from "@/lib/quality-server";

export const metadata: Metadata = { title: t("quality.compose.title") };

/**
 * Compose an evidence pack (QUAL-003; quality.md rule 1; HZ-050): the composer's own locations
 * and the people they can see, chosen one by one.
 */
export default async function ComposeEvidencePackPage() {
  const { me, locationId } = await getShellContext();
  const title = t("quality.compose.title");
  if (!me.permissions.includes(COMPOSE)) return <SafetyForbidden title={title} />;
  const { names, locations } = await getPeopleNames();
  const locationName = new Map(me.locations.map((l) => [l.id, l.name]));
  const people = [...names.entries()]
    .map(([id, name]) => {
      const where = locationName.get(locations.get(id) ?? "");
      return { id, label: name, ...(where ? { hint: where } : {}) };
    })
    .sort((a, b) => a.label.localeCompare(b.label, "en-GB"));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link
          href="/quality/evidence-packs"
          className="inline-flex min-h-target items-center underline"
        >
          {t("quality.packs.title")}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{title}</span>
      </nav>
      <PageHeader title={title} description={t("quality.compose.description")} />
      <ComposePackForm
        locations={me.locations.map((l) => ({ id: l.id, label: l.name }))}
        people={people}
        defaultLocationIds={locationId ? [locationId] : []}
      />
    </div>
  );
}
