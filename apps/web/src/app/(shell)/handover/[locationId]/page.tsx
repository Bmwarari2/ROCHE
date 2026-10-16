import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { ClipboardList } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CompileHandover } from "@/components/care/HandoverActions";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { currentHandover, handoverChips, handoverShown, shiftTitle } from "@/lib/handover";
import { t } from "@/lib/i18n";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = { title: t("care.handover.title") };

/**
 * A location's shift handovers (care.md rule 14; COMMS-006): the shift running now, compiled or
 * to compile, and the last week's, each with where it stands in an icon and words.
 */
export default async function LocationHandoverPage({ params }: { readonly params: Params }) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("care.handover.title");
  if (!handoverShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const listed = await api.GET("/v1/locations/{id}/handovers", {
    params: { path: { id: locationId } },
  });
  if (problemCode(listed.error) === "not_found") notFound();
  if (problemCode(listed.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!listed.data) failWith(listed.error, listed.response, `/handover/${locationId}`);
  const current = currentHandover(listed.data.items);
  const earlier = listed.data.items.filter((h) => h.id !== current?.id);
  const link = (id: string, text: string) => (
    <Link
      href={`/handover/${locationId}/${id}`}
      className="inline-flex min-h-target items-center underline"
    >
      {text}
    </Link>
  );

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("care.handover.description")}
      />
      <Card as="section" title={t("care.handover.currentTitle")} headingLevel={2}>
        {current ? (
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-body font-semibold">
              {link(current.id, shiftTitle(current, t))}
            </h3>
            <p className="m-0 flex flex-wrap items-center gap-2">
              {handoverChips(current, t).map((chip) => (
                <SafetyChip key={chip.label} chip={chip} />
              ))}
            </p>
            <p className="m-0 text-body-dense">
              {t("care.handover.itemCount", {
                count: current.itemCount,
                late: current.lateAdditionCount,
              })}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="m-0">{t("care.handover.notCompiled")}</p>
            <CompileHandover locationId={locationId} label={t("care.handover.compile")} />
          </div>
        )}
      </Card>
      <Card as="section" title={t("care.handover.earlierTitle")} headingLevel={2}>
        {earlier.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<ClipboardList size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("care.handover.noEarlier")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {earlier.map((h) => (
              <li key={h.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="font-semibold">{link(h.id, shiftTitle(h, t))}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {handoverChips(h, t).map((chip) => (
                    <SafetyChip key={chip.label} chip={chip} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
