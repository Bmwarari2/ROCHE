import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Heart } from "lucide-react";
import type { Metadata } from "next";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { NewComplimentForm } from "@/components/safety-silos/ComplaintForms";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { complaintsShown } from "@/lib/complaints";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("complaints.compliment.title") };

/** Compliments, newest first, and the form to record one (never a clock; SAFE-011). */
export default async function ComplimentsPage() {
  const { me, locationId } = await getShellContext();
  const title = t("complaints.compliment.title");
  if (!complaintsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/compliments", {
    params: { query: locationId ? { locationId } : {} },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/complaints/compliments");
  }
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("complaints.compliment.description")} />
      <Card as="section" headingLevel={2} title={t("complaints.compliment.new")}>
        <NewComplimentForm
          locations={me.locations.map((l) => ({ id: l.id, name: l.name }))}
          locationId={locationId}
        />
      </Card>
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Heart size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("complaints.compliment.empty")}
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
                title={t("complaints.compliment.itemTitle", {
                  name: item.fromName,
                  when: formatDateTime(item.receivedAt) ?? "",
                })}
              >
                <p className="m-0 whitespace-pre-wrap">{item.summary}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
