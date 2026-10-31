import type { WorkflowInstanceItem } from "@harbour/contracts";
import { Card, PageHeader } from "@harbour/ui";
import { TriangleAlert, UserRoundX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { IncidentApproval } from "@/components/approvals/IncidentApproval";
import { Notice } from "@/components/care/Notice";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import {
  APPROVALS_PAGE,
  type ApprovalGroup,
  approvalGroups,
  approvalsShown,
  incidentApprovalView,
  raisedByLine,
  slaChip,
  workflowItemTitle,
  workflowLink,
  workflowStateChip,
} from "@/lib/approvals";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { doneToShow, manageDone } from "@/lib/incident-review";
import { incidentTitle } from "@/lib/incidents";

export const metadata: Metadata = { title: t("approvals.title") };

const GROUPS: readonly ApprovalGroup[] = ["yours", "raised", "other"];
const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

function Item({ item }: { readonly item: WorkflowInstanceItem }) {
  const href = workflowLink(item);
  const label = workflowItemTitle(item, t);
  const describedBy = `workflow-${item.id}`;
  // From the steps and facts the API found for the reader where the incident is.
  const manage = incidentApprovalView(item);
  return (
    <li
      className="flex flex-col gap-2 border-b border-border pb-4 break-words"
      data-workflow={item.definitionKey}
    >
      <h3 className="m-0 text-body font-semibold">
        {href ? (
          <Link
            href={href}
            aria-describedby={describedBy}
            className="inline-flex min-h-target items-center underline"
          >
            {label}
          </Link>
        ) : (
          label
        )}
      </h3>
      <span className="flex flex-wrap items-center gap-2">
        <SafetyChip chip={workflowStateChip(item, t)} />
        <SafetyChip chip={slaChip(item, t)} />
      </span>
      <div id={describedBy} className="flex flex-col gap-1 text-body-dense text-text-secondary">
        <span>{raisedByLine(item, t)}</span>
        <span>{t("approvals.since", { when: formatDateTime(item.enteredStateAt) ?? "" })}</span>
      </div>
      {item.raisedByYou ? (
        <Notice icon={<UserRoundX {...iconProps} />} title={t("approvals.raisedByYou")} />
      ) : null}
      {manage && item.incident ? (
        <IncidentApproval
          incidentId={item.subjectId}
          version={item.incident.version}
          view={manage}
          path={`${APPROVALS_PAGE}?incident=${item.subjectId}`}
        />
      ) : !item.raisedByYou && href && item.moves.length > 0 ? (
        <p className="m-0">{t("approvals.nextStep")}</p>
      ) : null}
    </li>
  );
}

/**
 * Approvals across modules (PLAT-011; platform.md, task and workflow engine): records waiting for
 * the reader's approval, those the reader raised that wait for someone else (separation of
 * duties: whoever raised a record cannot approve it), and every other open record in the reader's
 * scope, each with its state and deadline as an icon and words and a link to its own page. An
 * incident waiting for the reader can be closed or sent back here with the incident page's own
 * forms; every other step is taken on the record's page, which checks its rules again.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const done = manageDone(params.done);
  const doneIncident =
    typeof params.incident === "string" && isUuid(params.incident) ? params.incident : null;
  const { me } = await getShellContext();
  const title = t("approvals.title");
  const forbidden = <SafetyForbidden title={title} hint={t("approvals.forbiddenHint")} />;
  if (!approvalsShown(me.permissions)) return forbidden;
  const api = await tenantApi();
  // One list: the API marks what waits for the reader and what they raised.
  const { data, error, response } = await api.GET("/v1/workflows", {
    params: { query: { view: "all" } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return forbidden;
    return failWith(error, response, APPROVALS_PAGE);
  }
  const groups = approvalGroups(data.items);
  // Say what was done only while the incident's status still matches (an old address says
  // nothing): the one incident just acted on is read, as its own page would be.
  const acted =
    done && doneIncident
      ? ((await api.GET("/v1/incidents/{id}", { params: { path: { id: doneIncident } } })).data ??
        undefined)
      : undefined;
  const shownDone = acted && done ? doneToShow(done, acted.status) : null;
  const now = new Date();

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("approvals.description")} />
      {acted && (shownDone === "closed" || shownDone === "reopened") ? (
        <RecordedArrival
          message={t("approvals.done", { done: shownDone, title: incidentTitle(acted, t) })}
          param="done"
        />
      ) : null}
      {data.truncated ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert {...iconProps} />}
          title={t("approvals.truncated")}
        />
      ) : null}
      <p className="m-0 text-body-dense text-text-secondary">
        {t("approvals.asOf", { time: formatDateTime(now.toISOString()) ?? "" })}
      </p>
      {GROUPS.map((group) => (
        <Card key={group} as="section" headingLevel={2} title={t("approvals.group", { group })}>
          {groups[group].length === 0 ? (
            <p className="m-0">
              {data.truncated ? t("approvals.emptyTruncated") : t("approvals.empty", { group })}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {groups[group].map((item) => (
                <Item key={item.id} item={item} />
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
