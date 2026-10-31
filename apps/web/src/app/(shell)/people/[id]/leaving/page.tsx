import type { ExitOut, KeyIssueOut, PropertyItemOut } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import { Archive, BellRing, Scale } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { RecordFrame } from "@/components/care/RecordFrame";
import { ExitChip } from "@/components/exit/ExitChip";
import {
  CancelPlan,
  DeathForm,
  type ExitDone,
  ItemActions,
  KeyReturn,
  LeavingForm,
  MoveButton,
  PropertyReturn,
} from "@/components/exit/ExitForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { getShellContext, tenantApi } from "@/lib/api";
import { tabHref, writeAccess } from "@/lib/care-record";
import {
  awaitingDraft,
  checklistParts,
  derivedLink,
  type ExitAction,
  type ExitEntry,
  exitActions,
  exitOpen,
  exitStateChip,
  itemChip,
  itemEditable,
  itemTitle,
  outstandingTitles,
  recordClosed,
} from "@/lib/exit";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("leaving");
}

const DONE: readonly ExitDone[] = [
  "planned",
  "left",
  "death",
  "item",
  "awaiting",
  "closed",
  "archived",
  "cancelled",
  "returned",
];

function Detail({ term, value }: { readonly term: string; readonly value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-body-dense text-text-secondary">{term}</dt>
      <dd className="m-0 font-semibold">{value}</dd>
    </div>
  );
}

/** A deadline instant as the UK date it falls on (dd/mm/yyyy). */
const ukDateOf = (instant: string | null) =>
  instant ? formatDate(ukToday(new Date(instant))) : null;

const detail = (exit: ExitOut, key: string): string | null => {
  const value = exit.details[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

/** What the exit is, its state, when the person left or died, and the return deadlines. */
function ExitSummary({ exit }: { readonly exit: ExitOut }) {
  const destination = detail(exit, "destinationType");
  return (
    <Card
      as="section"
      headingLevel={3}
      title={t("people.exit.kind", { kind: exit.kind })}
      actions={<ExitChip chip={exitStateChip(exit, t)} />}
      data-testid="exit-summary"
    >
      <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Detail
          term={t("people.exit.summary.when", { kind: exit.kind })}
          value={formatDateTime(exit.leftAt)}
        />
        <Detail
          term={t("people.exit.destination.label")}
          value={destination ? t("people.exit.destination", { destination }) : null}
        />
        <Detail
          term={t("people.exit.receivingProvider")}
          value={detail(exit, "receivingProviderName")}
        />
        <Detail term={t("people.exit.reason")} value={detail(exit, "reason")} />
        <Detail
          term={t("people.exit.death.place")}
          value={
            exit.context.placeOfDeath
              ? t("people.exit.death.placeOption", { place: exit.context.placeOfDeath })
              : null
          }
        />
        <Detail
          term={t("people.exit.death.expected")}
          value={
            exit.context.deathExpected === null
              ? null
              : exit.context.deathExpected
                ? t("people.exit.death.expectedYes")
                : t("people.exit.death.expectedNo")
          }
        />
        <Detail
          term={t("people.exit.summary.moneyAndPropertyBy")}
          value={ukDateOf(exit.deadlines.moneyAndPropertyBy)}
        />
        <Detail
          term={t("people.exit.summary.depositBy")}
          value={ukDateOf(exit.deadlines.depositBy)}
        />
        <Detail term={t("people.exit.summary.closedAt")} value={formatDateTime(exit.closedAt)} />
        <Detail term={t("people.exit.summary.cancelledReason")} value={exit.cancelledReason} />
      </dl>
    </Card>
  );
}

/** One item: its title, state, owner and notification, and what can be done about it here. */
function ChecklistItem({
  entry,
  exit,
  actions,
  personId,
  path,
}: {
  readonly entry: ExitEntry;
  readonly exit: ExitOut;
  readonly actions: ReadonlySet<ExitAction>;
  readonly personId: string;
  readonly path: string;
}) {
  const title = itemTitle(entry, exit.kind, t);
  const link = derivedLink(entry);
  const notification = entry.notification;
  return (
    <li
      className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0"
      data-item={entry.key}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="m-0 text-body font-semibold">{title}</h4>
        <ExitChip chip={itemChip(entry, t)} />
        {notification?.statutory ? (
          <StatusChip status="info" icon={Scale} label={t("people.exit.statutory")} />
        ) : null}
      </div>
      <p className="m-0 text-body-dense text-text-secondary">
        {t("people.exit.owner", { owner: entry.owner })}
      </p>
      {notification ? (
        <p className="m-0 flex items-start gap-2 text-body-dense">
          <BellRing size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            {t("people.exit.tells", {
              recipient: notification.recipient,
              due: notification.due.kind,
            })}
          </span>
        </p>
      ) : null}
      {entry.doneAt ? (
        <p className="m-0 text-body-dense">
          {t("people.exit.doneAt", {
            status: entry.status,
            dateTime: formatDateTime(entry.doneAt) ?? "",
          })}
        </p>
      ) : null}
      {entry.reason ? (
        <p className="m-0 text-body-dense">
          {t("people.exit.notRequiredBecause", { reason: entry.reason })}
        </p>
      ) : null}
      {link?.kind === "notification" ? (
        <p className="m-0">
          <Link href={link.href} className="font-semibold text-link underline">
            {t("people.exit.link.notification", { item: title })}
          </Link>
        </p>
      ) : null}
      {link?.kind === "returns" && entry.status === "pending" ? (
        <p className="m-0 text-body-dense">{t("people.exit.link.returns")}</p>
      ) : null}
      {entry.derived && !link ? (
        <p className="m-0 text-body-dense">{t("people.exit.derived")}</p>
      ) : null}
      {awaitingDraft(entry, exit.context.regulator) ? (
        <p className="m-0 text-body-dense">{t("people.exit.awaitingDraft")}</p>
      ) : null}
      {itemEditable(entry, actions, exit.context.regulator) ? (
        <ItemActions
          personId={personId}
          path={path}
          itemKey={entry.key}
          itemTitle={title}
          status={entry.status}
          allowNotRequired={entry.allowNotRequired}
          version={entry.version}
        />
      ) : null}
    </li>
  );
}

function Checklist({
  heading,
  entries,
  ...rest
}: {
  readonly heading: string;
  readonly entries: readonly ExitEntry[];
  readonly exit: ExitOut;
  readonly actions: ReadonlySet<ExitAction>;
  readonly personId: string;
  readonly path: string;
}) {
  if (entries.length === 0) return null;
  return (
    <Card as="section" headingLevel={3} title={heading}>
      <ul className="m-0 flex list-none flex-col p-0">
        {entries.map((entry) => (
          <ChecklistItem key={entry.key} entry={entry} {...rest} />
        ))}
      </ul>
    </Card>
  );
}

/** Property and keys still held, with the return forms for those who may return them. */
function Returns({
  property,
  keys,
  canReturn,
  personId,
  path,
  death,
}: {
  readonly property: readonly PropertyItemOut[];
  readonly keys: readonly KeyIssueOut[];
  readonly canReturn: boolean;
  readonly personId: string;
  readonly path: string;
  readonly death: boolean;
}) {
  const held = property.filter((p) => p.status === "held" || p.status === "sent_with_person");
  const outstandingKeys = keys.filter((k) => k.outstanding);
  return (
    <Card
      as="section"
      headingLevel={3}
      title={t("people.exit.returns.title")}
      id="returns"
      tabIndex={-1}
    >
      {held.length === 0 && outstandingKeys.length === 0 ? (
        <p className="m-0">{t("people.exit.returns.none")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {held.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="m-0 text-body font-semibold">
                  {t("people.exit.returns.property", {
                    description: item.description,
                    quantity: item.quantity,
                  })}
                </h4>
                <StatusChip
                  status="due"
                  label={t("people.exit.returns.held", { status: item.status })}
                />
                {item.valuable ? (
                  <StatusChip status="info" label={t("people.exit.returns.valuable")} />
                ) : null}
              </div>
              {canReturn && item.status === "held" ? (
                <PropertyReturn
                  personId={personId}
                  path={path}
                  itemId={item.id}
                  description={item.description}
                  version={item.version}
                  death={death}
                />
              ) : null}
            </li>
          ))}
          {outstandingKeys.map((key) => (
            <li
              key={key.id}
              className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="m-0 text-body font-semibold">
                  {t("people.exit.returns.key", { label: key.label })}
                </h4>
                <StatusChip status="due" label={t("people.exit.returns.keyOutstanding")} />
              </div>
              {canReturn ? (
                <KeyReturn
                  personId={personId}
                  path={path}
                  keyId={key.id}
                  label={key.label}
                  version={key.version}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The record's Leaving tab (PEOP-010; people.md rules 11 and 12): the discharge, transfer or death
 * workflow with its checklist, notifications and returns, and the forms that start it. Every rule
 * is the API's; this page offers only what the permissions reaching the person allow, and nothing
 * once the record is archived.
 */
async function LeavingTab({
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
  const api = await tenantApi();
  const path = tabHref(id, "leaving");
  const view = await api
    .GET("/v1/people/{id}/exit", { params: { path: { id } } })
    .then((r) => readOrFail(r, path));
  const exit = view?.exit ?? null;
  const may = (permission: string) => writeAccess(person, me.permissions, permission).canWrite;
  const actions = exitActions(person.status, exit, may);
  const closedRecord = recordClosed(person.status);
  const left = person.status === "discharged" || person.status === "deceased";

  const showReturns = exit !== null && exitOpen(exit) && left;
  const [property, keys] = showReturns
    ? await Promise.all([
        api
          .GET("/v1/people/{id}/property", { params: { path: { id } } })
          .then((r) => readOrFail(r, path)),
        api
          .GET("/v1/people/{id}/keys", { params: { path: { id } } })
          .then((r) => readOrFail(r, path)),
      ])
    : [null, null];

  const doneParam = firstParam((await searchParams).done);
  const done = DONE.find((d) => d === doneParam);
  const parts = exit ? checklistParts(exit) : null;
  const awaitingNext = exit && (exit.state === "left" || exit.state === "recorded");
  const outstanding =
    exit && exitOpen(exit) && exit.state !== "planned"
      ? awaitingNext && !exit.status.readyForReturn
        ? {
            next: "awaiting",
            keys: exit.status.outstanding.filter(
              (k) => !exit.status.outstandingReturns.includes(k),
            ),
          }
        : !exit.status.readyToClose
          ? {
              next: "close",
              keys: [...new Set([...exit.status.outstanding, ...exit.status.outstandingReturns])],
            }
          : null
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="leaving-tab">
      {done ? <RecordedArrival message={t("people.exit.done", { done })} param="done" /> : null}
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("people.exit.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("people.exit.intro")}</p>
      </div>

      {closedRecord ? (
        <div
          className="flex max-w-prose items-start gap-3 rounded-input border-s-4 border-border bg-bg-secondary p-4"
          data-testid="archived-notice"
        >
          <Archive size={20} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="m-0 font-semibold">
              {t("platform.search.status", { status: person.status })}
            </p>
            <p className="m-0">{t("people.exit.archived.body", { status: person.status })}</p>
          </div>
        </div>
      ) : null}

      {exit ? <ExitSummary exit={exit} /> : null}
      {!exit && actions.size === 0 && !closedRecord ? (
        <p className="m-0">{t("people.exit.none")}</p>
      ) : null}

      {actions.has("cancelPlan") && exit ? (
        <CancelPlan personId={id} path={path} version={exit.version} />
      ) : null}

      {exit && parts ? (
        <>
          <Checklist
            heading={t("people.exit.checklist.first")}
            entries={parts.first}
            exit={exit}
            actions={actions}
            personId={id}
            path={path}
          />
          <Checklist
            heading={t("people.exit.checklist.returns")}
            entries={parts.returns}
            exit={exit}
            actions={actions}
            personId={id}
            path={path}
          />
        </>
      ) : null}

      {showReturns ? (
        <Returns
          property={property?.items ?? []}
          keys={keys?.items ?? []}
          canReturn={actions.has("returns")}
          personId={id}
          path={path}
          death={exit?.kind === "death"}
        />
      ) : null}

      {exit && outstanding && outstanding.keys.length > 0 ? (
        <p className="m-0 max-w-prose" data-testid="exit-outstanding">
          {t("people.exit.outstanding", {
            next: outstanding.next,
            items: outstandingTitles(exit, outstanding.keys, t).join("; "),
          })}
        </p>
      ) : null}

      {exit && actions.has("awaitReturns") ? (
        <MoveButton personId={id} path={path} move="awaitReturns" version={exit.version} />
      ) : null}
      {exit && actions.has("close") ? (
        <MoveButton personId={id} path={path} move="close" version={exit.version} />
      ) : null}
      {actions.has("archive") ? (
        <MoveButton personId={id} path={path} move="archive" version={person.version} />
      ) : null}

      {actions.has("recordDischarge") ? (
        <LeavingForm
          // A new form once a plan exists, so its fields start from the plan (uncontrolled inputs
          // keep what they had otherwise).
          key={`${exit?.id ?? "none"}-${exit?.state ?? "none"}-${exit?.version ?? 0}`}
          personId={id}
          path={path}
          version={person.version}
          mode={exit?.state === "planned" ? "left" : "record"}
          {...(exit?.state === "planned" && exit.kind !== "death"
            ? {
                plannedKind: exit.kind,
                planned: {
                  holdsResidentsMoney: exit.context.holdsResidentsMoney,
                  holdsDeposit: exit.context.holdsDeposit,
                  hasLoanEquipment: exit.context.hasLoanEquipment,
                  homeIsDwpAppointee: exit.context.homeIsDwpAppointee,
                  destinationType: detail(exit, "destinationType"),
                  receivingProviderName: detail(exit, "receivingProviderName"),
                  reason: detail(exit, "reason"),
                },
              }
            : {})}
        />
      ) : null}
      {actions.has("plan") ? (
        <LeavingForm personId={id} path={path} version={person.version} mode="plan" />
      ) : null}
      {actions.has("recordDeath") ? (
        <DeathForm
          personId={id}
          path={path}
          version={person.version}
          inHospital={person.status === "in_hospital"}
        />
      ) : null}
    </div>
  );
}

export default async function PersonLeavingPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="leaving">
      <LeavingTab {...props} />
    </RecordFrame>
  );
}
