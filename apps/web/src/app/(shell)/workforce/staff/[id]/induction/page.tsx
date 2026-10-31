import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  decideProbation,
  recordCareCertificateStep,
  recordProbationReview,
  recordShadowShift,
  setInductionPlan,
  tickInductionItem,
} from "@/app/actions/workforce";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  COMPETENCE_OBSERVE,
  checklistChip,
  codeLabel,
  codeOptions,
  present,
  STAFF_FILE_MANAGE,
  staffShown,
  standardChip,
  ukDate,
} from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.induction.title") };

const TICKED = new Set([
  "contract_issued",
  "system_access_set_up",
  "uniform_and_badge",
  "location_induction",
  "fire_safety_briefing",
  "shadowing_signed_off",
]);

/**
 * A new starter's induction (workforce.md rules 19 to 21; WORK-004): the checklist with each
 * item's status in words, read-and-sign counts, shadow shifts, probation and the Care
 * Certificate's 16 standards (ids and short titles only, H-531). Nobody records on their own file.
 */
export default async function InductionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("workforce.induction.title");
  if (!staffShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const [found, files, colleagues] = await Promise.all([
    api.GET("/v1/workforce/staff-files/{id}/induction", { params: { path: { id } } }),
    api.GET("/v1/workforce/staff-files"),
    api.GET("/v1/workforce/colleagues"),
  ]);
  if (!found.data) failWith(found.error, found.response, `/workforce/staff/${id}/induction`);
  const induction = found.data;
  const file = files.data?.items.find((f) => f.id === id);
  const own = file?.member?.id === me.tenantUserId;
  const manages = me.permissions.includes(STAFF_FILE_MANAGE) && !own;
  const observes = me.permissions.includes(COMPETENCE_OBSERVE) && !own;
  const path = `/workforce/staff/${id}/induction`;
  const staff = present(colleagues.data?.items)
    .filter((c) => c.id !== file?.member?.id)
    .map((c) => ({ value: c.id, label: c.displayName }));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("workforce.staff.title")}
        title={t("workforce.induction.heading", {
          name: file?.member?.displayName ?? t("workforce.someone"),
        })}
        description={
          induction.startsOn
            ? t("workforce.induction.started", { date: ukDate(induction.startsOn) })
            : t("workforce.induction.noStart")
        }
      />
      <section aria-labelledby="checklist" className="flex flex-col gap-3">
        <h2 id="checklist" className="m-0 text-heading-3 font-semibold">
          {t("workforce.induction.checklist")}
        </h2>
        <Card>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {induction.checklist.map((item) => (
              <li
                key={item.kind}
                className="flex flex-col gap-2 border-b border-border pb-3 last:border-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{codeLabel("workforce.induction.item", item.kind, t)}</span>
                  <SafetyChip chip={checklistChip(item.status, t)} />
                </div>
                {item.doneOn ? (
                  <span className="text-body-dense text-text-secondary">
                    {t("workforce.induction.doneOn", { date: ukDate(item.doneOn) })}
                  </span>
                ) : null}
                {manages && TICKED.has(item.kind) && item.status !== "done" ? (
                  <WorkforceForm
                    headingLevel={3}
                    title={t("workforce.induction.tick", {
                      item: codeLabel("workforce.induction.item", item.kind, t),
                    })}
                    path={path}
                    submit={t("workforce.induction.tick", {
                      item: codeLabel("workforce.induction.item", item.kind, t),
                    })}
                    done="workforce.induction.ticked"
                    action={tickInductionItem.bind(null, id, item.kind)}
                    fields={[
                      {
                        kind: "date",
                        name: "doneOn",
                        label: t("workforce.induction.doneOnLabel"),
                        required: true,
                      },
                    ]}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          <p className="m-0 mt-3 text-body-dense">
            {t("workforce.induction.policies", {
              signed: induction.policies.signed,
              required: induction.policies.required,
            })}
          </p>
        </Card>
      </section>
      {manages ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.induction.plan")}
            intro={t("workforce.induction.planIntro")}
            path={path}
            submit={t("workforce.induction.savePlan")}
            done="workforce.induction.planSaved"
            action={setInductionPlan.bind(null, id, induction.planVersion)}
            fields={[
              {
                kind: "date",
                name: "probationEndsOn",
                label: t("workforce.induction.probationEnds"),
                defaultValue: induction.probation.endsOn,
              },
              {
                kind: "checkbox",
                name: "careCertificateHeld",
                label: t("workforce.induction.careCertificateHeld"),
              },
            ]}
          />
        </Card>
      ) : null}
      <section aria-labelledby="probation" className="flex flex-col gap-3">
        <h2 id="probation" className="m-0 text-heading-3 font-semibold">
          {t("workforce.induction.probation")}
        </h2>
        <Card>
          <p className="m-0 text-body-dense">
            {induction.probation.outcome
              ? t("workforce.induction.probationDecided", {
                  outcome: codeLabel("workforce.induction.outcome", induction.probation.outcome, t),
                  date: ukDate(induction.probation.decidedOn),
                })
              : induction.probation.endsOn
                ? t("workforce.induction.probationRuns", {
                    date: ukDate(induction.probation.endsOn),
                  })
                : t("workforce.induction.noProbation")}
          </p>
          <p className="m-0 mt-2 text-body-dense">
            {t("workforce.induction.shadowCount", { count: induction.shadowShifts.length })}
          </p>
          {induction.probation.reviews.length > 0 ? (
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
              {induction.probation.reviews.map((r) => (
                <li key={r.id} className="text-body-dense">
                  {t("workforce.induction.reviewLine", {
                    date: ukDate(r.reviewOn),
                    outcome: codeLabel("workforce.induction.reviewOutcome", r.outcome, t),
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        {manages ? (
          <>
            <Card>
              <WorkforceForm
                headingLevel={3}
                title={t("workforce.induction.shadowNew")}
                path={path}
                submit={t("workforce.induction.shadowRecord")}
                done="workforce.induction.shadowRecorded"
                action={recordShadowShift.bind(null, id)}
                fields={[
                  {
                    kind: "date",
                    name: "shiftOn",
                    label: t("workforce.induction.shadowOn"),
                    required: true,
                  },
                  {
                    kind: "select",
                    name: "shadowedId",
                    label: t("workforce.induction.shadowed"),
                    required: true,
                    emptyOption: t("workforce.form.choose"),
                    options: staff,
                  },
                ]}
              />
            </Card>
            <Card>
              <WorkforceForm
                headingLevel={3}
                title={t("workforce.induction.reviewNew")}
                path={path}
                submit={t("workforce.induction.reviewRecord")}
                done="workforce.induction.reviewRecorded"
                action={recordProbationReview.bind(null, id)}
                fields={[
                  {
                    kind: "date",
                    name: "reviewOn",
                    label: t("workforce.induction.reviewOn"),
                    required: true,
                  },
                  {
                    kind: "select",
                    name: "outcome",
                    label: t("workforce.induction.reviewOutcomeLabel"),
                    required: true,
                    emptyOption: t("workforce.form.choose"),
                    options: codeOptions(
                      ["on_track", "concerns"],
                      "workforce.induction.reviewOutcome",
                      t,
                    ),
                  },
                  {
                    kind: "textarea",
                    name: "notes",
                    label: t("workforce.induction.reviewNotes"),
                    maxLength: 4000,
                  },
                ]}
              />
            </Card>
            {induction.planVersion !== null &&
            induction.probation.endsOn &&
            induction.probation.outcome !== "passed" &&
            induction.probation.outcome !== "not_passed" ? (
              <Card>
                <WorkforceForm
                  headingLevel={3}
                  title={t("workforce.induction.decide")}
                  intro={t("workforce.induction.decideIntro")}
                  path={path}
                  submit={t("workforce.induction.decideSubmit")}
                  done="workforce.induction.decided"
                  action={decideProbation.bind(null, id, induction.planVersion)}
                  fields={[
                    {
                      kind: "select",
                      name: "outcome",
                      label: t("workforce.induction.outcomeLabel"),
                      required: true,
                      emptyOption: t("workforce.form.choose"),
                      options: codeOptions(
                        ["passed", "extended", "not_passed"],
                        "workforce.induction.outcome",
                        t,
                      ),
                    },
                    {
                      kind: "date",
                      name: "decidedOn",
                      label: t("workforce.induction.decidedOn"),
                      required: true,
                    },
                    {
                      kind: "date",
                      name: "newEndsOn",
                      label: t("workforce.induction.newEnd"),
                      hint: t("workforce.induction.newEndHint"),
                    },
                  ]}
                />
              </Card>
            ) : null}
          </>
        ) : null}
      </section>
      <section aria-labelledby="care-certificate" className="flex flex-col gap-3">
        <h2 id="care-certificate" className="m-0 text-heading-3 font-semibold">
          {t("workforce.careCertificate.title")}
        </h2>
        <p className="m-0 text-body-dense">
          {induction.careCertificate.complete
            ? t("workforce.careCertificate.complete", {
                date: ukDate(induction.careCertificate.completedOn),
              })
            : t("workforce.careCertificate.progress", {
                count: induction.careCertificate.competent,
              })}
        </p>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {induction.careCertificate.standards.map((s) => (
            <li key={s.id}>
              <Card>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="m-0 text-body font-semibold">{s.title}</h3>
                    <SafetyChip chip={standardChip(s.status, t)} />
                  </div>
                  {(manages || observes) && s.status === "not_started" ? (
                    <WorkforceForm
                      headingLevel={4}
                      title={t("workforce.careCertificate.assess", { standard: s.title })}
                      path={path}
                      submit={t("workforce.careCertificate.assess", { standard: s.title })}
                      done="workforce.careCertificate.assessed"
                      action={recordCareCertificateStep.bind(null, id, s.id, "knowledge")}
                      fields={[
                        {
                          kind: "date",
                          name: "on",
                          label: t("workforce.careCertificate.assessedOn"),
                          required: true,
                        },
                      ]}
                    />
                  ) : null}
                  {observes && s.status === "knowledge_assessed" ? (
                    <WorkforceForm
                      headingLevel={4}
                      title={t("workforce.careCertificate.observe", { standard: s.title })}
                      path={path}
                      submit={t("workforce.careCertificate.observe", { standard: s.title })}
                      done="workforce.careCertificate.observed"
                      action={recordCareCertificateStep.bind(null, id, s.id, "observation")}
                      fields={[
                        {
                          kind: "date",
                          name: "on",
                          label: t("workforce.careCertificate.observedOn"),
                          required: true,
                        },
                      ]}
                    />
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
