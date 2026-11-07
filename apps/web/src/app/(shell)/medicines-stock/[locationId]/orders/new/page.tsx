import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { PackagePlus, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import { NewOrderForm, type OrderGroup } from "@/components/medicines/stock/LocationStockForms";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  entryUnitName,
  locationStockHref,
  newOrderHref,
  openableEntries,
  stockManaged,
} from "@/lib/medicine-stock";
import { personNames } from "@/lib/people";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = { title: t("medicines.stock.order.newTitle") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Starting an order for a cycle (slice 55; MEDS-008; medicines.md section 15 rule 7): each person
 * at the home whom the reader may see, with each medicine on their MAR in force and its dose unit;
 * the reader types a quantity for each one to order. The first day of the next cycle is offered.
 * The API checks each line is the person's own medicine here and never a controlled drug.
 */
export default async function NewMedicineOrderPage({ params }: { readonly params: Params }) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.stock.order.newTitle");
  if (!stockManaged(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const [cycle, people] = await Promise.all([
    api.GET("/v1/locations/{id}/medicine-cycle", { params: { path: { id: locationId } } }),
    api.GET("/v1/people", { params: { query: { locationId } } }),
  ]);
  if (problemCode(cycle.error) === "not_found") notFound();
  if (problemCode(cycle.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!cycle.data) failWith(cycle.error, cycle.response, newOrderHref(locationId));
  const residents = people.data?.items ?? [];
  const records = await Promise.all(
    residents.map((p) => api.GET("/v1/people/{id}/medicines", { params: { path: { id: p.id } } })),
  );
  const unreadable = Boolean(people.error) || records.some((r) => !r.data);
  const groups: OrderGroup[] = residents
    .map((person, i) => ({
      personId: person.id,
      name: personNames(person).full,
      needs: <PersonNeeds person={person} />,
      medicines: openableEntries(records[i]?.data?.entries ?? [], []).map((e) => ({
        medicationId: e.id,
        productName: e.product.name,
        unitName: entryUnitName(e),
      })),
    }))
    .filter((g) => g.medicines.length > 0);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("medicines.stock.order.newIntro")}
      />
      {unreadable ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert {...iconProps} />}
          title={t("medicines.stock.order.someUnreadable")}
        />
      ) : null}
      <Card as="section" title={t("medicines.stock.order.linesTitle")} headingLevel={2}>
        {groups.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<PackagePlus {...iconProps} />}
            title={t("medicines.stock.order.nothingToOrder")}
          />
        ) : (
          <NewOrderForm
            locationId={locationId}
            cycleStartsOn={cycle.data.nextCycleStartsOn}
            groups={groups}
          />
        )}
      </Card>
      <p className="m-0">
        <Link
          href={locationStockHref(locationId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("medicines.stock.back")}
        </Link>
      </p>
    </div>
  );
}
