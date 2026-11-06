import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { DeclareOutbreakForm } from "@/components/safety-events/OutbreakForms";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { outbreakStateChip, outbreaksShown } from "@/lib/outbreaks";

export const metadata: Metadata = { title: t("outbreaks.title") };

/**
 * Outbreaks at the homes in the reader's scope (Phase 2 slice 63; SAFE-013): each with its illness,
 * organism and state as an icon and a word, newest first, and the form to declare one.
 */
export default async function OutbreaksPage() {
  const { me, locationId } = await getShellContext();
  const title = t("outbreaks.title");
  if (!outbreaksShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/safety/outbreaks", {
    params: { query: locationId ? { locationId } : {} },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/outbreaks");
  }
  const location = me.locations.find((l) => l.id === locationId);
  const names = new Map(me.locations.map((l) => [l.id, l.name]));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("outbreaks.description")}
      />
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<ShieldCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("outbreaks.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((item) => (
            <li key={item.id}>
              <Card
                as="article"
                headingLevel={2}
                className="break-words"
                title={
                  <Link
                    href={`/outbreaks/${item.id}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("outbreaks.itemTitle", {
                      syndrome: t("outbreaks.syndrome", { value: item.syndrome }),
                      when: formatDateTime(item.declaredAt) ?? "",
                    })}
                  </Link>
                }
              >
                <div className="flex flex-col gap-2">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip chip={outbreakStateChip(item.state, t)} />
                  </p>
                  <p className="m-0 text-body-dense text-text-secondary">
                    {item.organism
                      ? t("outbreaks.organism", { organism: item.organism })
                      : t("outbreaks.organismUnknown")}
                  </p>
                  <p className="m-0 text-body-dense text-text-secondary">
                    {names.get(item.locationId) ?? t("outbreaks.locationHidden")}
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Card as="section" headingLevel={2} title={t("outbreaks.form.title")}>
        <DeclareOutbreakForm
          locations={me.locations.map((l) => ({ id: l.id, name: l.name }))}
          locationId={locationId}
        />
      </Card>
    </div>
  );
}
