import type { AdmissionDecisionItem } from "@harbour/contracts";
import { ButtonLink, Card, StatusChip } from "@harbour/ui";
import { CircleCheck, Clock } from "lucide-react";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import { AssessmentSectionForm } from "@/components/people/admission/AssessmentSectionForm";
import { AssessmentSourcesForm } from "@/components/people/admission/AssessmentSourcesForm";
import { ConditionMetButton } from "@/components/people/admission/ConditionMetButton";
import { DecisionForm } from "@/components/people/admission/DecisionForm";
import {
  EnquiryReasonForm,
  StartAssessmentForm,
} from "@/components/people/admission/EnquiryStatusForms";
import {
  DecisionChip,
  PersonStatusChip,
  SafetyCriticalChip,
} from "@/components/people/admission/StatusChips";
import {
  ADMISSION_MANAGE,
  ASSESSMENT_WRITERS,
  admissionReadiness,
  assessmentProgress,
  assessmentSections,
  currentDecision,
  ENQUIRY_MANAGE,
  type SectionView,
  sectionChip,
  whoDid,
} from "@/lib/admission";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("pre-admission");
}

const ARRIVALS = new Set(["enquiry", "started", "rereferred"]);

/** One section of the assessment, with what was recorded and, for writers, its form. */
function Section({
  section,
  personId,
  version,
  me,
  canWrite,
}: {
  readonly section: SectionView;
  readonly personId: string;
  readonly version: number | null;
  readonly me: string;
  readonly canWrite: boolean;
}) {
  const title = t("people.preAdmission.sectionTitle", { key: section.key });
  const headingId = `section-${section.key}`;
  const by = whoDid(section.completedBy, me);
  return (
    <li className="border-b border-border py-4 last:border-b-0">
      <article aria-labelledby={headingId} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h5 id={headingId} className="m-0 text-body font-semibold">
            {title}
          </h5>
          <StatusChip
            status={sectionChip(section)}
            label={t("people.preAdmission.section.state", { state: section.state })}
          />
          {section.required ? null : (
            <StatusChip status="neutral" label={t("people.preAdmission.section.optional")} />
          )}
          {section.hazardIds.length > 0 ? <SafetyCriticalChip /> : null}
        </div>
        {section.notes ? (
          <p className="m-0 max-w-prose whitespace-pre-wrap">{section.notes}</p>
        ) : null}
        {section.state === "not_applicable" && section.notApplicableReason ? (
          <p className="m-0">
            {t("people.preAdmission.section.reasonShown", {
              reason: section.notApplicableReason,
            })}
          </p>
        ) : null}
        {section.key === "medicines" && section.state !== "not_started" ? (
          section.medicines && section.medicines.length > 0 ? (
            <ul className="m-0 flex flex-col gap-1 ps-5">
              {section.medicines.map((m, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the list is shown as recorded, in its order.
                <li key={index}>
                  {t("people.preAdmission.medicines.line", {
                    name: m.name,
                    dose: m.dose,
                    route: m.route,
                    frequency: m.frequency,
                  })}
                  {m.timeCritical ? (
                    <>
                      {" "}
                      <StatusChip
                        status="due"
                        icon={Clock}
                        label={t("people.preAdmission.medicines.timeCriticalChip")}
                      />
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0">{t("people.preAdmission.medicines.noneListed")}</p>
          )
        ) : null}
        {section.completedAt ? (
          <p className="m-0 text-body-dense text-text-secondary">
            {t("people.preAdmission.section.recorded", {
              when: formatDateTime(section.completedAt) ?? "",
              by,
            })}
          </p>
        ) : null}
        {canWrite && version !== null ? (
          <AssessmentSectionForm
            personId={personId}
            version={version}
            sectionKey={section.key}
            title={title}
            allowNotApplicable={section.allowNotApplicable}
            safetyFact={section.hazardIds.length > 0 && !section.allowNotApplicable}
            initial={{
              status:
                section.state === "not_started"
                  ? null
                  : section.state === "complete" || section.state === "not_applicable"
                    ? section.state
                    : "in_progress",
              notes: section.notes,
              notApplicableReason: section.notApplicableReason,
              medicines: section.medicines,
            }}
          />
        ) : null}
      </article>
    </li>
  );
}

/** One decision to admit: the answer, reasons, conditions and who decided; a replaced one struck. */
function Decision({
  decision,
  personId,
  me,
  confirm,
  replacedBy,
  headingLevel,
}: {
  readonly decision: AdmissionDecisionItem;
  readonly personId: string;
  readonly me: string;
  readonly confirm: boolean;
  readonly replacedBy: AdmissionDecisionItem | null;
  /** The level of the conditions' heading: one below the heading the decision sits under. */
  readonly headingLevel: 4 | 5;
}) {
  const struck = decision.superseded;
  const ConditionsHeading = headingLevel === 4 ? "h4" : "h5";
  return (
    <article
      aria-label={t("people.decision.label", {
        when: formatDateTime(decision.decidedAt) ?? "",
        superseded: struck ? "yes" : "no",
      })}
      className="flex flex-col gap-2 rounded-input border border-border p-4"
      data-superseded={struck ? "" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DecisionChip canMeetNeeds={decision.canMeetNeeds} />
        {struck ? (
          <StatusChip status="notApplicable" label={t("people.decision.replaced")} />
        ) : null}
      </div>
      <p className={`m-0 max-w-prose whitespace-pre-wrap ${struck ? "line-through" : ""}`}>
        {decision.reasons}
      </p>
      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-body-dense sm:grid-cols-[max-content_1fr]">
        <dt className="font-semibold">{t("people.decision.decided")}</dt>
        <dd className="m-0">
          {t("people.decision.decidedBy", {
            when: formatDateTime(decision.decidedAt) ?? "",
            by: whoDid(decision.decidedBy, me),
          })}
        </dd>
        {decision.plannedAdmissionOn ? (
          <>
            <dt className="font-semibold">{t("people.decision.planned")}</dt>
            <dd className="m-0">{formatDate(decision.plannedAdmissionOn)}</dd>
          </>
        ) : null}
        {decision.trialEndsOn ? (
          <>
            <dt className="font-semibold">{t("people.decision.trialEnds")}</dt>
            <dd className="m-0">{formatDate(decision.trialEndsOn)}</dd>
          </>
        ) : null}
        <dt className="font-semibold">{t("people.decision.told")}</dt>
        <dd className="m-0">
          {decision.toldWho && decision.toldAt
            ? t("people.decision.toldWhoWhen", {
                who: decision.toldWho,
                when: formatDateTime(decision.toldAt) ?? "",
              })
            : t("common.notRecorded")}
        </dd>
        {decision.correctionReason ? (
          <>
            <dt className="font-semibold">{t("people.decision.correction")}</dt>
            <dd className="m-0">{decision.correctionReason}</dd>
          </>
        ) : null}
        {replacedBy ? (
          <>
            <dt className="font-semibold">{t("people.decision.replacedOn")}</dt>
            <dd className="m-0">{formatDateTime(replacedBy.decidedAt)}</dd>
          </>
        ) : null}
      </dl>
      {decision.conditions.length > 0 ? (
        <section aria-label={t("people.decision.conditionsTitle")} className="flex flex-col gap-2">
          <ConditionsHeading className="m-0 text-body font-semibold">
            {t("people.decision.conditionsTitle")}
          </ConditionsHeading>
          <ol className="m-0 flex flex-col gap-3 ps-5">
            {decision.conditions.map((condition, index) => (
              <li key={condition.id} className="flex flex-col gap-1">
                <span className={struck ? "line-through" : ""}>{condition.condition}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {condition.metAt ? (
                    <StatusChip
                      status="done"
                      icon={CircleCheck}
                      label={t("people.decision.condition.met", {
                        when: formatDateTime(condition.metAt) ?? "",
                        by: whoDid(condition.metBy, me),
                      })}
                    />
                  ) : (
                    <StatusChip status="due" label={t("people.decision.condition.notMet")} />
                  )}
                </span>
                {confirm && !struck ? (
                  <ConditionMetButton
                    personId={personId}
                    decisionId={decision.id}
                    conditionId={condition.id}
                    version={condition.version}
                    number={index + 1}
                    met={condition.metAt !== null}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </article>
  );
}

/**
 * The pre-admission tab (people.md rules 1, 4 and 5; PEOP-005): the enquiry and its status, the
 * twenty sections of the assessment with who the information came from and how the person took
 * part, and the decision to admit with its reasons and conditions. Nurses and managers write the
 * sections (care.plan.write or people.admission.manage); only managers decide and confirm
 * conditions (people.admission.manage); enquiries are opened and closed by people.enquiry.manage.
 * Nothing here is scored: the decision is a person's, with their reasons.
 */
async function PreAdmissionTab({
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
  const path = tabHref(id, "pre-admission");
  const [view, decisions, services] = await Promise.all([
    api
      .GET("/v1/people/{id}/pre-admission", { params: { path: { id } } })
      .then((r) => readOrFail(r, path)),
    api
      .GET("/v1/people/{id}/admission-decisions", { params: { path: { id } } })
      .then((r) => readOrFail(r, path)),
    api
      .GET("/v1/locations/{id}/services", { params: { path: { id: person.locationId } } })
      .then((r) => r.data ?? null),
  ]);
  if (!view || !decisions) return <NoAccess />;
  const query = await searchParams;
  const done = firstParam(query.done);
  const status = person.status;
  const atPreAdmission = status === "pre_admission";
  const enquiry = writeAccess(person, me.permissions, ENQUIRY_MANAGE);
  const manage = writeAccess(person, me.permissions, ADMISSION_MANAGE);
  const writers = ASSESSMENT_WRITERS.map((p) => writeAccess(person, me.permissions, p));
  const writeSections = writers.some((w) => w.canWrite);
  const readOnlyNotice = writers.find((w) => w.readOnlyNotice)?.readOnlyNotice ?? null;
  const assessment = view.assessment;
  const sections = assessmentSections(view);
  const progress = assessmentProgress(sections);
  const { current, earlier } = currentDecision(decisions.items);
  const readiness = admissionReadiness(current);
  const serviceName = (serviceId: string | null) =>
    services?.items.find((s) => s.id === serviceId)?.name ?? null;
  const replacedBy = (decision: AdmissionDecisionItem) =>
    decisions.items.find((d) => d.supersedesId === decision.id) ?? null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-eyebrow">{t("people.preAdmission.title")}</h2>
        <PersonStatusChip status={status} />
      </div>
      {done && ARRIVALS.has(done) ? (
        <TemplateArrival message={t("people.preAdmission.arrived", { done })} />
      ) : null}

      <Card as="section" title={t("people.preAdmission.enquiry.title")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          <p className="m-0">
            {t("people.preAdmission.enquiry.status", {
              status,
              since: formatDateTime(person.statusChangedAt) ?? "",
            })}
          </p>
          {status === "enquiry" && enquiry.canWrite ? (
            services && services.items.length > 0 ? (
              <StartAssessmentForm
                personId={id}
                version={person.version}
                services={services.items.map((s) => ({ id: s.id, name: s.name }))}
              />
            ) : (
              <p className="m-0">{t("people.preAdmission.start.noServices")}</p>
            )
          ) : null}
          {(status === "enquiry" || status === "pre_admission") && enquiry.canWrite ? (
            <EnquiryReasonForm personId={id} version={person.version} to="not_admitted" />
          ) : null}
          {status === "not_admitted" && enquiry.canWrite ? (
            <EnquiryReasonForm personId={id} version={person.version} to="enquiry" />
          ) : null}
        </div>
      </Card>

      <Card as="section" title={t("people.preAdmission.assessment.title")} headingLevel={3}>
        {!assessment ? (
          <p className="m-0">{t("people.preAdmission.assessment.none", { status })}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold">{t("people.preAdmission.assessment.service")}</dt>
              <dd className="m-0">
                {serviceName(assessment.serviceId) ?? t("common.notRecorded")}
              </dd>
              <dt className="font-semibold">{t("people.preAdmission.assessment.type")}</dt>
              <dd className="m-0">
                {assessment.placementTypeSought
                  ? t("people.placementType", { type: assessment.placementTypeSought })
                  : t("common.notRecorded")}
              </dd>
              <dt className="font-semibold">{t("people.preAdmission.assessment.progressLabel")}</dt>
              <dd className="m-0 flex flex-wrap items-center gap-2">
                {assessment.completeness.complete ? (
                  <StatusChip status="done" label={t("people.preAdmission.assessment.complete")} />
                ) : (
                  <StatusChip status="due" label={t("people.preAdmission.assessment.incomplete")} />
                )}
                <span>{t("people.preAdmission.assessment.progress", progress)}</span>
              </dd>
            </dl>
            {readOnlyNotice && atPreAdmission ? <ReadOnlyNotice text={t(readOnlyNotice)} /> : null}

            <section aria-labelledby="assessment-sources" className="flex flex-col gap-2">
              <h4 id="assessment-sources" className="m-0 text-body font-semibold">
                {t("people.preAdmission.sources.title")}
              </h4>
              <p className="m-0">
                {assessment.informationSources.length > 0
                  ? t("people.preAdmission.sources.list", {
                      sources: assessment.informationSources
                        .map((source) => t("people.preAdmission.source", { source }))
                        .join(", "),
                    })
                  : t("people.preAdmission.sources.none")}
              </p>
              <p className="m-0">
                {assessment.personInvolvement === null
                  ? t("people.preAdmission.involvement.none")
                  : assessment.personInvolvement.involved
                    ? t("people.preAdmission.involvement.shownYes")
                    : t("people.preAdmission.involvement.shownNo", {
                        reason: assessment.personInvolvement.reason,
                      })}
              </p>
              {writeSections && atPreAdmission ? (
                <AssessmentSourcesForm
                  personId={id}
                  version={assessment.version}
                  sources={assessment.informationSources}
                  involved={assessment.personInvolvement?.involved ?? null}
                  reason={
                    assessment.personInvolvement && !assessment.personInvolvement.involved
                      ? assessment.personInvolvement.reason
                      : null
                  }
                />
              ) : null}
            </section>

            <section aria-labelledby="assessment-sections" className="flex flex-col gap-1">
              <h4 id="assessment-sections" className="m-0 text-body font-semibold">
                {t("people.preAdmission.sections.title")}
              </h4>
              <p className="m-0 text-text-secondary">{t("people.preAdmission.sections.hint")}</p>
              <ol className="m-0 flex list-none flex-col p-0">
                {sections.map((section) => (
                  <Section
                    key={section.key}
                    section={section}
                    personId={id}
                    version={assessment.version}
                    me={me.tenantUserId}
                    canWrite={writeSections && atPreAdmission}
                  />
                ))}
              </ol>
            </section>
          </div>
        )}
      </Card>

      <Card as="section" title={t("people.decision.title")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          {current ? (
            <Decision
              decision={current}
              personId={id}
              me={me.tenantUserId}
              confirm={manage.canWrite && atPreAdmission}
              replacedBy={null}
              headingLevel={4}
            />
          ) : (
            <p className="m-0">{t("people.decision.none")}</p>
          )}
          {current && !current.admit && atPreAdmission ? (
            <p className="m-0">{t("people.decision.declinedNext")}</p>
          ) : null}
          {readiness.ready && atPreAdmission ? (
            <div className="flex flex-col gap-2">
              <p className="m-0">{t("people.decision.readyNext")}</p>
              <div>
                <ButtonLink href={tabHref(id, "admission")}>
                  {t("people.decision.goToAdmission")}
                </ButtonLink>
              </div>
            </div>
          ) : null}
          {manage.canWrite && atPreAdmission && assessment ? (
            assessment.completeness.complete || current ? (
              <section aria-labelledby="decision-form" className="flex flex-col gap-3">
                <h4 id="decision-form" className="m-0 text-body font-semibold">
                  {current
                    ? t("people.decision.form.replaceTitle")
                    : t("people.decision.form.title")}
                </h4>
                <DecisionForm personId={id} replaces={current?.id ?? null} />
              </section>
            ) : (
              <p className="m-0">{t("people.decision.finishFirst")}</p>
            )
          ) : null}
          {earlier.length > 0 ? (
            <section aria-labelledby="decision-history" className="flex flex-col gap-3">
              <h4 id="decision-history" className="m-0 text-body font-semibold">
                {t("people.decision.history")}
              </h4>
              {earlier.map((decision) => (
                <Decision
                  key={decision.id}
                  decision={decision}
                  personId={id}
                  me={me.tenantUserId}
                  confirm={false}
                  replacedBy={replacedBy(decision)}
                  headingLevel={5}
                />
              ))}
            </section>
          ) : null}
        </div>
      </Card>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function PreAdmissionPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="pre-admission">
      <PreAdmissionTab {...props} />
    </RecordFrame>
  );
}
