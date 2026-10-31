import type { ContactOut, SharingDecisionOut } from "@harbour/contracts";
import { Button, Card, SelectField, StatusChip } from "@harbour/ui";
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  LockKeyhole,
  LockKeyholeOpen,
  Pause,
} from "lucide-react";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import { DecisionActionForm, SharingDecisionForm } from "@/components/people/SharingForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { contactName, isAuthorityRole } from "@/lib/person-details";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";
import {
  authorityRolesFor,
  DECISION_CHIPS,
  decisionActions,
  decisionStatus,
  orderDecisions,
  type RecipientNames,
  recipientLabel,
  SHARING_SECTION_KEYS,
} from "@/lib/sharing";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("sharing");
}

const CHIP_ICONS = {
  "circle-check": CircleCheck,
  pause: Pause,
  "circle-x": CircleX,
  clock: Clock,
  ban: Ban,
};

const DONE_ACTIONS = new Set(["recorded", "suspend", "lift", "withdraw"]);

/** A recipient chosen for the visibility check, as `contact:<id>`, `user:<id>` or `link:<id>`. */
function parseRecipient(
  value: string | undefined,
): { readonly kind: "contactId" | "tenantUserId" | "linkId"; readonly id: string } | null {
  const [kind, id] = (value ?? "").split(":");
  if (!id || !isUuid(id)) return null;
  if (kind === "contact") return { kind: "contactId", id };
  if (kind === "user") return { kind: "tenantUserId", id };
  if (kind === "link") return { kind: "linkId", id };
  return null;
}

function DecisionCard({
  decision,
  names,
  now,
  meId,
  personId,
  path,
  canWrite,
}: {
  readonly decision: SharingDecisionOut;
  readonly names: RecipientNames;
  readonly now: Date;
  readonly meId: string;
  readonly personId: string;
  readonly path: string;
  readonly canWrite: boolean;
}) {
  const status = decisionStatus(decision, now);
  const chip = DECISION_CHIPS[status];
  const recipient = recipientLabel(decision.recipient, names, t);
  const authority = decision.authority;
  const holder = authority ? names.contacts.get(authority.contactId) : undefined;
  // In the order the form lists them, whatever order they were chosen in.
  const sections = [...decision.sections]
    .sort((x, y) => SHARING_SECTION_KEYS.indexOf(x) - SHARING_SECTION_KEYS.indexOf(y))
    .map((section) =>
      section === "care_plan" && decision.carePlanDomains === null
        ? `${t("people.sharing.sectionName", { section })} (${t("people.sharing.allDomains")})`
        : t("people.sharing.sectionName", { section }),
    )
    .join(", ");
  const basis = [
    t("people.sharing.basis", { basis: decision.basis }),
    decision.consentGivenBy ? t("people.sharing.consentBy", { by: decision.consentGivenBy }) : null,
  ]
    .filter(Boolean)
    .join(". ");
  const rows: (readonly [string, string | null])[] = [
    ["sections", sections],
    ["basis", basis],
    ["capacity", t("people.sharing.capacity", { capacity: decision.capacity })],
    [
      "authority",
      authority
        ? t("people.sharing.authorityLine", {
            role: t("people.sharing.authorityRole", { role: authority.role }),
            name: holder ? contactName(holder) : t("people.sharing.unknownContact"),
          })
        : null,
    ],
    [
      "period",
      t("people.sharing.period", {
        from: formatDateTime(decision.validFrom) ?? "",
        to: formatDateTime(decision.validTo) ?? "",
      }),
    ],
    [
      "recordedBy",
      t("people.sharing.by", { by: decision.recordedBy === meId ? "you" : "colleague" }),
    ],
    [
      "suspensions",
      decision.suspensions.length > 0
        ? decision.suspensions
            .map((s) =>
              s.liftedAt
                ? t("people.sharing.suspensionLifted", {
                    from: formatDateTime(s.suspendedAt) ?? "",
                    to: formatDateTime(s.liftedAt) ?? "",
                    reason: s.reason,
                  })
                : t("people.sharing.suspensionOpen", {
                    from: formatDateTime(s.suspendedAt) ?? "",
                    reason: s.reason,
                  }),
            )
            .join("\n")
        : null,
    ],
  ];
  return (
    <li className="flex flex-col gap-3 border-b border-border pb-4" data-decision={decision.id}>
      <div className="flex flex-col gap-1">
        <h4 className="m-0 text-body font-semibold">{recipient}</h4>
        <p className="m-0 flex flex-wrap items-center gap-2">
          {chip.status === "neutral" ? (
            <StatusChip
              status="neutral"
              label={t("people.sharing.status", { status })}
              icon={CHIP_ICONS[chip.icon]}
            />
          ) : (
            <StatusChip
              status={chip.status}
              label={t("people.sharing.status", { status })}
              icon={CHIP_ICONS[chip.icon]}
            />
          )}
        </p>
      </div>
      {status === "not_in_force" ? (
        <p className="m-0 max-w-prose">{t("people.sharing.notInForceDetail")}</p>
      ) : null}
      {decision.withdrawnAt ? (
        <p className="m-0">
          {t("people.sharing.withdrawnLine", {
            dateTime: formatDateTime(decision.withdrawnAt) ?? "",
            reason: decision.withdrawnReason ?? "",
          })}
        </p>
      ) : null}
      <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {rows
          .filter(([, value]) => Boolean(value))
          .map(([field, value]) => (
            <div key={field} className="min-w-0">
              <dt className="text-body-dense font-semibold">
                {t("people.sharing.field", { field })}
              </dt>
              <dd className="m-0 whitespace-pre-line break-words">{value}</dd>
            </div>
          ))}
      </dl>
      {canWrite ? (
        <div className="flex flex-col gap-3">
          {decisionActions(decision, now).map((action) => (
            <DecisionActionForm
              key={action}
              personId={personId}
              path={path}
              decisionId={decision.id}
              version={decision.version}
              action={action}
              recipient={recipient}
            />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The sharing tab (PEOP-013; people.md rule 13; HZ-022): every sharing decision with whether it
 * is in force, in words and an icon; recording one; suspending, lifting or withdrawing one with a
 * reason; and what one recipient can see now, section by section, closed by default. Only for
 * `people.sharing.manage`; the API decides what is in force.
 */
async function SharingTab({
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
  if (!can(me.permissions, "people.sharing.manage")) return <NoAccess />;
  const query = await searchParams;
  const done = firstParam(query.done);
  const at = firstParam(query.at) ?? "first";
  const check = parseRecipient(firstParam(query.recipient));
  const path = tabHref(id, "sharing");
  const { canWrite, readOnlyNotice } = writeAccess(person, me.permissions, "people.sharing.manage");
  const api = await tenantApi();
  const readPlans = can(me.permissions, "care.plan.read");
  const [decisions, contacts, members, assessments, bestInterests, links, visibility] =
    await Promise.all([
      api
        .GET("/v1/people/{id}/sharing-decisions", { params: { path: { id } } })
        .then((r) => readOrFail(r, path)),
      api
        .GET("/v1/people/{id}/contacts", { params: { path: { id } } })
        .then((r) => readOrFail(r, path)),
      can(me.permissions, "platform.user.manage")
        ? api.GET("/v1/members", { params: { query: { locationId: person.locationId } } })
        : null,
      readPlans
        ? api.GET("/v1/people/{id}/capacity-assessments", { params: { path: { id } } })
        : null,
      readPlans ? api.GET("/v1/people/{id}/best-interests", { params: { path: { id } } }) : null,
      api.GET("/v1/people/{id}/about-me/links", { params: { path: { id } } }),
      check
        ? api.GET("/v1/people/{id}/sharing-decisions/visibility", {
            params: { path: { id }, query: { [check.kind]: check.id } },
          })
        : null,
    ]);
  if (!decisions || !contacts) return <NoAccess />;
  const now = new Date();
  const name = personNames(person).preferred;
  const staff = new Map((members?.data?.items ?? []).map((m) => [m.id, m.displayName] as const));
  const contactMap = new Map<string, ContactOut>(contacts.items.map((c) => [c.id, c]));
  const names: RecipientNames = { contacts: contactMap, staff };
  const ordered = orderDecisions(decisions.items, now);
  const live = contacts.items.filter((c) => !c.expired);
  const contactChoices = live.map((c) => ({
    value: c.id,
    label: `${contactName(c)}, ${t("people.contacts.role", { role: c.role })}`,
  }));
  const authorities = live
    .filter((c) => isAuthorityRole(c.role))
    .map((c) => ({
      value: c.id,
      label: `${contactName(c)}, ${t("people.contacts.role", { role: c.role })}`,
      roles: authorityRolesFor(c),
    }));
  const sharingAssessments = (assessments?.data?.items ?? [])
    .filter((a) => a.decisionKind === "sharing" && !a.superseded)
    .map((a) => ({
      value: a.id,
      outcome: a.outcome,
      label: t("people.sharing.form.assessmentOption", {
        date: formatDate(ukToday(new Date(a.assessedAt))) ?? "",
        decision: a.decision,
      }),
    }));
  const bestInterestChoices = (bestInterests?.data?.items ?? [])
    .filter((b) => !b.superseded)
    .map((b) => ({
      value: b.id,
      label: t("people.sharing.form.bestInterestsOption", {
        date: formatDate(ukToday(new Date(b.decidedAt))) ?? "",
        decision: b.decision,
      }),
    }));
  const professionals = members?.data
    ? members.data.items
        .filter((m) => m.state === "active" && m.id !== me.tenantUserId)
        .map((m) => ({ value: m.id, label: m.displayName }))
    : null;
  const recipientOptions = [
    ...contacts.items.map((c) => ({
      value: `contact:${c.id}`,
      label: `${contactName(c)}, ${t("people.contacts.role", { role: c.role })}`,
    })),
    ...(professionals ?? []).map((p) => ({ value: `user:${p.value}`, label: p.label })),
    ...(links.data?.items ?? []).map((l) => ({
      value: `link:${l.id}`,
      label: t("people.sharing.check.link", { dateTime: formatDateTime(l.createdAt) ?? "" }),
    })),
  ];
  const checked = check
    ? recipientOptions.find((o) => o.value === firstParam(query.recipient))
    : null;

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("people.sharing.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("people.sharing.intro", { name })}</p>
      </div>
      {done && DONE_ACTIONS.has(done) ? (
        <TemplateArrival key={at} message={t("people.sharing.done", { action: done })} />
      ) : null}
      {readOnlyNotice ? <ReadOnlyNotice text={t(readOnlyNotice)} /> : null}
      <Card as="section" title={t("people.sharing.decisions")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          {ordered.length === 0 ? (
            <p className="m-0">{t("people.sharing.none")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {ordered.map((decision) => (
                <DecisionCard
                  key={`${decision.id}:${at}`}
                  decision={decision}
                  names={names}
                  now={now}
                  meId={me.tenantUserId}
                  personId={id}
                  path={path}
                  canWrite={canWrite}
                />
              ))}
            </ul>
          )}
          {canWrite ? (
            <SharingDecisionForm
              key={at}
              personId={id}
              path={path}
              contacts={contactChoices}
              professionals={professionals}
              authorities={authorities}
              assessments={sharingAssessments}
              bestInterests={bestInterestChoices}
            />
          ) : null}
        </div>
      </Card>
      <Card as="section" title={t("people.sharing.check.title")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          <p className="m-0 max-w-prose text-text-secondary">{t("people.sharing.check.intro")}</p>
          <form method="get" action={path} className="flex flex-wrap items-end gap-3">
            <SelectField
              name="recipient"
              label={t("people.sharing.check.recipient")}
              emptyOption={t("people.sharing.form.choose")}
              defaultValue={checked?.value ?? ""}
              options={recipientOptions}
              className="max-w-md"
            />
            <Button type="submit" variant="secondary">
              {t("people.sharing.check.submit")}
            </Button>
          </form>
          {visibility?.data && checked ? (
            <div className="flex flex-col gap-2" data-visibility="">
              <p className="m-0 text-body-dense text-text-secondary">
                {t("people.sharing.check.capacity", {
                  capacity: t("people.sharing.capacity", {
                    capacity: visibility.data.capacityForSharing,
                  }),
                })}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-start">
                  <caption className="mb-2 text-start font-semibold">
                    {t("people.sharing.check.caption", { recipient: checked.label })}
                  </caption>
                  <thead>
                    <tr>
                      {(["section", "state", "detail"] as const).map((column) => (
                        <th
                          key={column}
                          scope="col"
                          className="border-b border-border p-2 text-start text-body-dense"
                        >
                          {t("people.sharing.check.column", { column })}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibility.data.sections.map((row) => (
                      <tr key={row.section} data-section={row.section}>
                        <th
                          scope="row"
                          className="border-b border-border p-2 text-start font-normal"
                        >
                          {t("people.sharing.sectionName", { section: row.section })}
                        </th>
                        <td className="border-b border-border p-2">
                          <span className="inline-flex items-center gap-2 font-semibold">
                            {row.visible ? (
                              <LockKeyholeOpen size={16} strokeWidth={1.5} aria-hidden="true" />
                            ) : (
                              <LockKeyhole size={16} strokeWidth={1.5} aria-hidden="true" />
                            )}
                            {t("people.sharing.check.state", {
                              visible: row.visible ? "yes" : "no",
                            })}
                          </span>
                        </td>
                        <td className="border-b border-border p-2">
                          {row.visible
                            ? t("people.sharing.check.openUntil", {
                                dateTime: formatDateTime(row.expiresAt) ?? "",
                              })
                            : t("people.sharing.check.reason", { reason: row.reason ?? "" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function SharingPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="sharing">
      <SharingTab {...props} />
    </RecordFrame>
  );
}
