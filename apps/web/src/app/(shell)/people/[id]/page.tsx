import { Meter, StatusChip, Tile } from "@harbour/ui";
import {
  Activity,
  CircleCheck,
  ClipboardCheck,
  ClipboardList,
  Droplets,
  History,
  NotebookPen,
  PencilLine,
  PersonStanding,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { RecordFrame } from "@/components/care/RecordFrame";
import { getShellContext, tenantApi } from "@/lib/api";
import { bandChip, bandLabel } from "@/lib/assessments";
import { planStatusChip, planVersions } from "@/lib/care-plan";
import { can, entryChains, tabHref, windowStart } from "@/lib/care-record";
import { fluidDayView, news2Chip, news2FromFlags } from "@/lib/charts";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;

export async function generateMetadata(): Promise<Metadata> {
  // The title names the tab, not the person: browser history and tab titles are visible to
  // anyone who uses the computer next.
  return recordMetadata("overview");
}

const planIcons = { "circle-check": CircleCheck, "pencil-line": PencilLine, history: History };

/**
 * The overview tab: what is in use and what was recorded lately, each a link into its section.
 * Every figure is the API's; nothing is calculated here.
 */
async function PersonOverviewTab({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  const readPlan = can(me.permissions, "care.plan.read");
  const readNotes = can(me.permissions, "care.note.read");
  const api = await tenantApi();
  const path = tabHref(id, "overview");
  const today = ukToday();
  const from = windowStart(3);

  const [plans, assessments, vitals, fluid, marks, notes] = await Promise.all([
    readPlan
      ? api
          .GET("/v1/people/{id}/care-plans", { params: { path: { id } } })
          .then((r) => readOrFail(r, path))
      : null,
    readPlan
      ? api
          .GET("/v1/people/{id}/assessments", {
            params: { path: { id }, query: { latest: "true" } },
          })
          .then((r) => readOrFail(r, path))
      : null,
    readNotes
      ? api
          .GET("/v1/people/{id}/observations", {
            params: { path: { id }, query: { chart: "vitals", from } },
          })
          .then((r) => readOrFail(r, path))
      : null,
    readNotes
      ? api
          .GET("/v1/people/{id}/charts/fluid", { params: { path: { id }, query: { date: today } } })
          .then((r) => readOrFail(r, path))
      : null,
    readNotes
      ? api
          .GET("/v1/people/{id}/body-map", {
            params: { path: { id }, query: { includeHealed: "false" } },
          })
          .then((r) => readOrFail(r, path))
      : null,
    readNotes
      ? api
          .GET("/v1/people/{id}/notes", { params: { path: { id }, query: { from } } })
          .then((r) => readOrFail(r, path))
      : null,
  ]);

  const versions = plans ? planVersions(plans.items) : null;
  const active = versions?.active ?? null;
  const planChip = active ? planStatusChip(active.status, t) : null;
  const PlanIcon = planChip ? planIcons[planChip.icon] : null;
  const latestVitals = vitals?.items.find((item) => !item.superseded) ?? null;
  const news2 = latestVitals ? news2FromFlags(latestVitals.flags) : null;
  const fluidView = fluid ? fluidDayView(fluid, t) : null;
  const recentNotes = notes ? entryChains(notes.items).slice(0, 3) : [];

  return (
    <>
      <h2 className="m-0 text-eyebrow">{t("care.overview.title")}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {versions ? (
          <Tile
            headingLevel={3}
            icon={<ClipboardList size={24} strokeWidth={1.5} />}
            title={t("care.overview.plan.title")}
            status={
              <span className="flex flex-wrap gap-2">
                {planChip && PlanIcon ? (
                  <StatusChip status={planChip.status} label={planChip.label} icon={PlanIcon} />
                ) : (
                  <StatusChip status="due" label={t("care.plan.none.title")} />
                )}
                {plans?.due?.overdue ? (
                  <StatusChip status="overdue" label={t("care.plan.due.overdue")} />
                ) : null}
              </span>
            }
            description={
              <>
                {active?.reviewDueOn ? (
                  <span className="block">
                    {t("care.plan.reviewDue", { date: formatDate(active.reviewDueOn) ?? "" })}
                  </span>
                ) : null}
                {plans?.due?.dueOn ? (
                  <span className="block">
                    {t(`care.plan.due.${plans.due.kind}`, {
                      date: formatDate(plans.due.dueOn) ?? "",
                    })}
                  </span>
                ) : null}
                {versions.draft ? (
                  <span className="block">{t("care.overview.plan.draftOpen")}</span>
                ) : null}
              </>
            }
            link={{ href: tabHref(id, "care-plan"), label: t("care.overview.plan.link") }}
            linkComponent={Link}
          />
        ) : null}
        {vitals ? (
          <Tile
            headingLevel={3}
            icon={<Activity size={24} strokeWidth={1.5} />}
            title={t("care.overview.vitals.title")}
            value={news2 ? t("care.news2.score", { score: news2.score }) : undefined}
            status={
              news2 ? (
                <StatusChip
                  status={news2Chip(news2.band)}
                  label={t("care.news2.clinicalRisk", { risk: news2.clinicalRisk })}
                  icon={Activity}
                />
              ) : undefined
            }
            description={
              latestVitals && news2 ? (
                <>
                  <span className="block font-semibold">
                    {t("care.news2.response", { response: news2.response })}
                  </span>
                  <span className="block">
                    {t("care.overview.vitals.when", {
                      dateTime: formatDateTime(latestVitals.occurredAt) ?? "",
                    })}
                  </span>
                </>
              ) : (
                t("care.overview.vitals.none")
              )
            }
            link={{
              href: `${tabHref(id, "charts")}?record=vitals`,
              label: t("care.overview.vitals.link"),
            }}
            linkComponent={Link}
          />
        ) : null}
        {fluid && fluidView ? (
          <Tile
            headingLevel={3}
            icon={<Droplets size={24} strokeWidth={1.5} />}
            title={t("care.overview.fluid.title")}
            link={{ href: tabHref(id, "charts"), label: t("care.overview.fluid.link") }}
            linkComponent={Link}
          >
            <Meter
              label={t("care.charts.fluid.meter", { date: formatDate(fluid.date) ?? fluid.date })}
              value={fluid.intakeMl}
              max={fluidView.meterMax}
              valueText={fluidView.valueText}
              description={<StatusChip status={fluidView.status} label={fluidView.statusText} />}
            />
          </Tile>
        ) : null}
        {assessments ? (
          <Tile
            headingLevel={3}
            icon={<ClipboardCheck size={24} strokeWidth={1.5} />}
            title={t("care.overview.assessments.title")}
            description={
              assessments.items.length === 0 ? t("care.overview.assessments.none") : undefined
            }
            link={{ href: tabHref(id, "assessments"), label: t("care.overview.assessments.link") }}
            linkComponent={Link}
          >
            {assessments.items.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {assessments.items.map((item) => {
                  const band = bandLabel(item, t);
                  return (
                    <li key={item.id} className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {t("care.assessments.tool", { tool: item.toolKey })}
                      </span>
                      {band ? <StatusChip status={bandChip(item)} label={band} /> : null}
                      <span className="text-text-secondary">
                        {formatDate(ukToday(new Date(item.occurredAt))) ?? ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </Tile>
        ) : null}
        {marks ? (
          <Tile
            headingLevel={3}
            icon={<PersonStanding size={24} strokeWidth={1.5} />}
            title={t("care.overview.bodyMap.title")}
            value={t("care.overview.bodyMap.count", { count: marks.items.length })}
            link={{ href: tabHref(id, "body-map"), label: t("care.overview.bodyMap.link") }}
            linkComponent={Link}
          />
        ) : null}
        {notes ? (
          <Tile
            headingLevel={3}
            icon={<NotebookPen size={24} strokeWidth={1.5} />}
            title={t("care.overview.notes.title")}
            description={recentNotes.length === 0 ? t("care.overview.notes.none") : undefined}
            link={{ href: tabHref(id, "notes"), label: t("care.overview.notes.link") }}
            linkComponent={Link}
          >
            {recentNotes.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {recentNotes.map(({ current }) => (
                  <li key={current.id}>
                    <span className="block text-callout text-text-secondary">
                      {formatDateTime(current.occurredAt)}{" "}
                      {t("care.notes.category", { category: current.category })}
                    </span>
                    <span className="line-clamp-2 block">{current.body}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Tile>
        ) : null}
      </div>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab, and the tabs. */
export default async function PersonOverviewPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="overview">
      <PersonOverviewTab {...props} />
    </RecordFrame>
  );
}
