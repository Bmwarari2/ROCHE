import type { PropertyItemOut } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import { Gem, KeyRound, Luggage } from "lucide-react";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import {
  AddPropertyForm,
  CloseKeyForm,
  DisposePropertyForm,
  IssueKeyForm,
  LosePropertyForm,
  ReturnPropertyForm,
} from "@/components/people/admission/PropertyForms";
import { PropertyStatusChip } from "@/components/people/admission/StatusChips";
import {
  keyChip,
  keysView,
  mayRecordPropertyIn,
  mayRecordPropertyOut,
  PROPERTY_MANAGE,
  propertyOpen,
  propertyView,
  returnCapacities,
  whoDid,
} from "@/lib/admission";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("property");
}

const ARRIVALS = new Set(["returned", "disposed", "lost", "keyReturned", "keyLost"]);

/** What the record says about one item: in, signed for, witnessed, and how it left. */
function ItemDetails({ item, me }: { readonly item: PropertyItemOut; readonly me: string }) {
  const ack = item.acknowledgement;
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-body-dense sm:grid-cols-[max-content_1fr]">
      <dt className="font-semibold">{t("people.property.received")}</dt>
      <dd className="m-0">
        {t("people.property.receivedValue", {
          on: formatDate(item.receivedOn) ?? "",
          by: whoDid(item.recordedBy, me),
        })}
      </dd>
      <dt className="font-semibold">{t("people.property.signedFor")}</dt>
      <dd className="m-0">
        {ack.signer === "unable_to_sign"
          ? t("people.property.unableShown", { reason: ack.unableReason ?? "" })
          : t("people.property.signedShown", { signer: ack.signer, name: ack.name ?? "" })}
      </dd>
      {item.witnessedBy ? (
        <>
          <dt className="font-semibold">{t("people.property.witnessed")}</dt>
          <dd className="m-0">
            {t("people.property.witnessedBy", { by: whoDid(item.witnessedBy, me) })}
          </dd>
        </>
      ) : null}
      {item.returned ? (
        <>
          <dt className="font-semibold">{t("people.property.returnedTitle")}</dt>
          <dd className="m-0">
            {t("people.property.returnedShown", {
              on: formatDate(item.returned.on) ?? "",
              name: item.returned.recipientName,
              capacity: item.returned.recipientCapacity,
            })}
          </dd>
        </>
      ) : null}
      {item.disposed ? (
        <>
          <dt className="font-semibold">{t("people.property.disposedTitle")}</dt>
          <dd className="m-0">
            {t("people.property.disposedShown", {
              on: formatDate(item.disposed.on) ?? "",
              reason: item.disposed.reason,
            })}
          </dd>
        </>
      ) : null}
      {item.lost ? (
        <>
          <dt className="font-semibold">{t("people.property.lostTitle")}</dt>
          <dd className="m-0">
            {t("people.property.lostShown", { on: formatDate(item.lost.on) ?? "" })}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * The property and keys tab (people.md rule 7; PEOP-007; Regulation 13): the inventory, with what
 * is still held or away with the person first (it keeps an exit open) and what goes with them to
 * hospital, recording items in, and returning, disposing of or recording each as lost once; then
 * keys and fobs issued and back. Writes need people.property.manage; the witness is always someone
 * other than the person recording. Cash is never an item: residents' money is a ledger.
 */
async function PropertyTab({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "people.person.read")) return <NoAccess />;
  const api = await tenantApi();
  const path = tabHref(id, "property");
  const manage = writeAccess(person, me.permissions, PROPERTY_MANAGE);
  const incidentsAllowed = manage.canWrite && can(me.permissions, "safety.incident.read");
  const [property, keys, incidents] = await Promise.all([
    api
      .GET("/v1/people/{id}/property", { params: { path: { id } } })
      .then((r) => readOrFail(r, path)),
    api.GET("/v1/people/{id}/keys", { params: { path: { id } } }).then((r) => readOrFail(r, path)),
    incidentsAllowed
      ? api
          .GET("/v1/incidents", { params: { query: { personId: id } } })
          .then((r) => r.data ?? null)
      : null,
  ]);
  if (!property || !keys) return <NoAccess />;
  const query = await searchParams;
  const done = firstParam(query.done);
  const at = firstParam(query.at) ?? "first";
  const today = ukToday();
  const status = person.status;
  // Items come in while the person lives here; returns follow after an exit too (rule 3).
  const recordIn = manage.canWrite && mayRecordPropertyIn(status);
  const recordOut = manage.canWrite && mayRecordPropertyOut(status);
  const { open, closed } = propertyView(property.items);
  const travels = new Set(property.toSendWithPerson);
  const incidentOptions =
    incidents?.items.map((incident) => ({
      id: incident.id,
      label: t("people.property.lose.incidentOption", {
        type: incident.type,
        when: formatDateTime(incident.occurredAt) ?? "",
      }),
    })) ?? null;
  const capacities = returnCapacities(status);

  const itemRow = (item: PropertyItemOut) => (
    <li key={item.id} className="flex flex-col gap-2 border-b border-border py-4 last:border-b-0">
      <article aria-labelledby={`item-${item.id}`} className="flex flex-col gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <h4 id={`item-${item.id}`} className="m-0 text-body font-semibold">
            {t("people.property.itemTitle", {
              description: item.description,
              quantity: item.quantity,
            })}
          </h4>
          <PropertyStatusChip status={item.status} />
          {item.valuable ? (
            <StatusChip status="neutral" icon={Gem} label={t("people.property.valuableChip")} />
          ) : null}
          {travels.has(item.id) ? (
            <StatusChip status="neutral" icon={Luggage} label={t("people.property.travelsChip")} />
          ) : null}
        </span>
        <span className="text-body-dense text-text-secondary">
          {t("people.property.category", { category: item.category })}
        </span>
        <ItemDetails item={item} me={me.tenantUserId} />
        {recordOut && propertyOpen(item) ? (
          <div className="flex flex-col gap-3">
            <ReturnPropertyForm
              personId={id}
              itemId={item.id}
              description={item.description}
              valuable={item.valuable}
              version={item.version}
              today={today}
              capacities={capacities}
            />
            <DisposePropertyForm
              personId={id}
              itemId={item.id}
              description={item.description}
              valuable={item.valuable}
              version={item.version}
              today={today}
            />
            <LosePropertyForm
              personId={id}
              itemId={item.id}
              description={item.description}
              valuable={item.valuable}
              version={item.version}
              today={today}
              incidents={incidentOptions}
            />
          </div>
        ) : null}
      </article>
    </li>
  );

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("people.property.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("people.property.intro")}</p>
      </div>
      {done && ARRIVALS.has(done) ? (
        <TemplateArrival key={at} message={t("people.property.arrived", { done })} />
      ) : null}
      {manage.readOnlyNotice ? <ReadOnlyNotice text={t(manage.readOnlyNotice)} /> : null}

      <Card
        as="section"
        title={t("people.property.inventoryTitle")}
        description={t("people.property.inventoryCount", {
          held: open.length,
          closed: closed.length,
        })}
        headingLevel={3}
      >
        {open.length === 0 ? (
          <p className="m-0">{t("people.property.noneHeld")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">{open.map(itemRow)}</ul>
        )}
      </Card>

      {recordIn ? (
        <Card as="section" title={t("people.property.form.title")} headingLevel={3}>
          <AddPropertyForm personId={id} today={today} />
        </Card>
      ) : null}

      {closed.length > 0 ? (
        <Card as="section" title={t("people.property.closedTitle")} headingLevel={3}>
          <ul className="m-0 flex list-none flex-col p-0">{closed.map(itemRow)}</ul>
        </Card>
      ) : null}

      <Card as="section" title={t("people.keys.title")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          {keys.items.length === 0 ? (
            <p className="m-0">{t("people.keys.none")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {keysView(keys.items).map((key) => {
                const chip = keyChip(key);
                return (
                  <li
                    key={key.id}
                    className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <KeyRound size={18} strokeWidth={1.5} aria-hidden="true" />
                      <span className="font-semibold">{key.label}</span>
                      <StatusChip
                        status={chip.status}
                        label={t("people.keys.state", { state: chip.state })}
                      />
                    </span>
                    <span className="text-body-dense">
                      {t("people.keys.issued", {
                        on: formatDate(key.issuedOn) ?? "",
                        to: key.issuedTo,
                      })}
                      {key.returnedOn
                        ? ` ${t("people.keys.returnedOn", { on: formatDate(key.returnedOn) ?? "" })}`
                        : ""}
                      {key.reportedLostOn
                        ? ` ${t("people.keys.lostOn", { on: formatDate(key.reportedLostOn) ?? "" })}`
                        : ""}
                    </span>
                    {recordOut && key.outstanding ? (
                      <div className="flex flex-col gap-3">
                        <CloseKeyForm
                          personId={id}
                          keyId={key.id}
                          label={key.label}
                          how="returned"
                          version={key.version}
                          today={today}
                        />
                        <CloseKeyForm
                          personId={id}
                          keyId={key.id}
                          label={key.label}
                          how="lost"
                          version={key.version}
                          today={today}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {recordIn ? (
            <section aria-labelledby="issue-key" className="flex flex-col gap-3">
              <h4 id="issue-key" className="m-0 text-body font-semibold">
                {t("people.keys.form.title")}
              </h4>
              <IssueKeyForm personId={id} today={today} />
            </section>
          ) : null}
        </div>
      </Card>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function PropertyPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="property">
      <PropertyTab {...props} />
    </RecordFrame>
  );
}
