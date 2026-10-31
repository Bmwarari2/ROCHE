import { COMPETENCES, TRAINING_TOPICS } from "@harbour/domain";
import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { BookOpen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  correctTraining,
  recordSupervision,
  recordTraining,
  saveRevalidation,
  signOffCompetence,
  withdrawCompetence,
} from "@/app/actions/development";
import { DevelopmentForm } from "@/components/development/DevelopmentForm";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  codeLabel,
  codeOptions,
  competenceChip,
  type DevelopmentField,
  developmentActions,
  developmentShown,
  meetingChip,
  REVALIDATION_REQUIREMENTS,
  requirementChip,
  SUPERVISION_KINDS,
  trainingChip,
  ukDate,
} from "@/lib/development";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("development.record.title") };

type Params = Promise<{ memberId: string }>;

/** The fields for recording or correcting a training record, with the record's values when correcting. */
function trainingFields(current?: {
  readonly topic: string;
  readonly tier: number | null;
  readonly completedOn: string;
  readonly expiresOn: string | null;
  readonly provider: string | null;
}): DevelopmentField[] {
  return [
    {
      kind: "select",
      name: "topic",
      label: t("development.training.topic"),
      required: true,
      emptyOption: t("development.form.choose"),
      options: codeOptions(TRAINING_TOPICS, "development.topic", t),
      ...(current ? { defaultValue: current.topic } : {}),
    },
    {
      kind: "select",
      name: "tier",
      label: t("development.training.tier"),
      hint: t("development.training.tierHint"),
      emptyOption: t("development.training.noTier"),
      options: [
        { value: "1", label: t("development.tier.1") },
        { value: "2", label: t("development.tier.2") },
      ],
      ...(current?.tier ? { defaultValue: String(current.tier) } : {}),
    },
    {
      kind: "date",
      name: "completedOn",
      label: t("development.training.completedOn"),
      required: true,
      ...(current ? { defaultValue: current.completedOn } : {}),
    },
    {
      kind: "date",
      name: "expiresOn",
      label: t("development.training.expiresOn"),
      hint: t("development.training.expiresOnHint"),
      ...(current?.expiresOn ? { defaultValue: current.expiresOn } : {}),
    },
    {
      kind: "text",
      name: "provider",
      label: t("development.training.provider"),
      maxLength: 160,
      ...(current?.provider ? { defaultValue: current.provider } : {}),
    },
  ];
}

/**
 * A member's training record (plan slice 57; WORK-005, WORK-008, WORK-009, WORK-012): their
 * required training today, the records behind it, observed competences and sign-offs, supervisions
 * and appraisals with their notes where the viewer may read them, and the revalidation planner.
 * Each form is offered only to the permission that may use it, and never on one's own record.
 */
export default async function MemberDevelopmentPage({ params }: { readonly params: Params }) {
  const { memberId } = await params;
  if (!isUuid(memberId)) notFound();
  const { me } = await getShellContext();
  const title = t("development.record.title");
  if (!developmentShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const loaded = await api.GET("/v1/workforce/members/{memberId}/development", {
    params: { path: { memberId } },
  });
  if (loaded.response.status === 404) notFound();
  if (!loaded.data) failWith(loaded.error, loaded.response, `/training/${memberId}`);
  const record = loaded.data;
  // The API names the member; a record without a name is one this viewer cannot read.
  if (!record.member) notFound();
  const member = record.member;
  const path = `/training/${memberId}`;
  const self = memberId === me.tenantUserId;
  const may = developmentActions(me.permissions, self);
  const name = member.displayName;
  const plan = record.revalidation;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-8">
      <PageHeader
        eyebrow={
          <Link href="/training" className="underline">
            {t("development.matrix.title")}
          </Link>
        }
        title={t("development.record.heading", { name })}
        description={member.jobTitle ?? t("development.record.noJobTitle")}
      />
      {self ? (
        <p className="m-0 max-w-prose text-body-dense">{t("development.record.self")}</p>
      ) : null}

      <section aria-labelledby="training" className="flex flex-col gap-4">
        <h2 id="training" className="m-0 text-heading-3 font-semibold">
          {t("development.training.title")}
        </h2>
        {record.matrix.length === 0 ? (
          <Card>
            <EmptyState
              headingLevel={3}
              icon={<BookOpen size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("development.training.noneNeeded")}
            />
          </Card>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
            {record.matrix.map((row) => (
              <li key={row.topic}>
                <Card>
                  <div className="flex flex-col gap-2">
                    <h3 className="m-0 text-body font-semibold">
                      {row.tier
                        ? t("development.topicWithTier", {
                            topic: codeLabel("development.topic", row.topic, t),
                            tier: codeLabel("development.tier", String(row.tier), t),
                          })
                        : codeLabel("development.topic", row.topic, t)}
                    </h3>
                    <p className="m-0">
                      <SafetyChip chip={trainingChip(row.status, t)} />
                    </p>
                    {row.validUntil ? (
                      <p className="m-0 text-body-dense text-text-secondary">
                        {t("development.matrix.until", { date: ukDate(row.validUntil) })}
                      </p>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        <h3 className="m-0 text-body font-semibold">{t("development.training.records")}</h3>
        {record.trainingRecords.length === 0 ? (
          <p className="m-0 text-body-dense">{t("development.training.noRecords")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {record.trainingRecords.map((r) => (
              <li key={r.id}>
                <Card>
                  <div className="flex flex-col gap-2">
                    <p className="m-0 font-semibold">
                      {t("development.training.recordLine", {
                        topic: codeLabel("development.topic", r.topic, t),
                        date: ukDate(r.completedOn),
                      })}
                    </p>
                    {r.provider ? (
                      <p className="m-0 text-body-dense text-text-secondary">
                        {t("development.training.by", { provider: r.provider })}
                      </p>
                    ) : null}
                    {r.expiresOn ? (
                      <p className="m-0 text-body-dense text-text-secondary">
                        {t("development.training.certificateUntil", { date: ukDate(r.expiresOn) })}
                      </p>
                    ) : null}
                    {may.recordTraining ? (
                      <details>
                        <summary className="inline-flex min-h-target cursor-pointer items-center underline">
                          {t("development.training.correct", {
                            topic: codeLabel("development.topic", r.topic, t),
                            date: ukDate(r.completedOn),
                          })}
                        </summary>
                        <div className="pt-3">
                          <DevelopmentForm
                            headingLevel={4}
                            title={t("development.training.correctTitle")}
                            intro={t("development.training.correctIntro")}
                            path={path}
                            submit={t("development.training.correctSubmit")}
                            done="development.training.corrected"
                            action={correctTraining.bind(null, memberId, r.id, r.version)}
                            fields={trainingFields(r)}
                          />
                        </div>
                      </details>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {may.recordTraining ? (
          <Card>
            <DevelopmentForm
              headingLevel={3}
              title={t("development.training.new")}
              intro={t("development.training.newIntro", { name })}
              path={path}
              submit={t("development.training.record")}
              done="development.training.recorded"
              action={recordTraining.bind(null, memberId)}
              fields={trainingFields()}
            />
          </Card>
        ) : null}
      </section>

      <section aria-labelledby="competence" className="flex flex-col gap-4">
        <h2 id="competence" className="m-0 text-heading-3 font-semibold">
          {t("development.competence.title")}
        </h2>
        <p className="m-0 max-w-prose text-body-dense">{t("development.competence.description")}</p>
        {record.competences.length === 0 ? (
          <p className="m-0 text-body-dense">{t("development.competence.none")}</p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
            {record.competences.map((c) => (
              <li key={c.competence}>
                <Card>
                  <div className="flex flex-col gap-2">
                    <h3 className="m-0 text-body font-semibold">
                      {codeLabel("development.competence.kind", c.competence, t)}
                    </h3>
                    <p className="m-0">
                      <SafetyChip chip={competenceChip(c, t)} />
                    </p>
                    {c.validUntil ? (
                      <p className="m-0 text-body-dense text-text-secondary">
                        {t("development.matrix.until", { date: ukDate(c.validUntil) })}
                      </p>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {record.signOffs.length > 0 ? (
          <>
            <h3 className="m-0 text-body font-semibold">{t("development.competence.signOffs")}</h3>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {record.signOffs.map((s) => (
                <li key={s.id}>
                  <Card>
                    <div className="flex flex-col gap-2">
                      <p className="m-0 font-semibold">
                        {t("development.competence.signOffLine", {
                          competence: codeLabel("development.competence.kind", s.competence, t),
                          date: ukDate(s.observedOn),
                          observer: s.observer?.displayName ?? t("development.someone"),
                        })}
                      </p>
                      {s.withdrawn ? (
                        <>
                          <p className="m-0 text-body-dense">
                            <SafetyChip
                              chip={{
                                status: "notApplicable",
                                icon: "circle-minus",
                                label: t("development.competence.withdrawnLine", {
                                  date: ukDate(s.withdrawn.on),
                                  who: s.withdrawn.by?.displayName ?? t("development.someone"),
                                }),
                              }}
                            />
                          </p>
                          <p className="m-0 text-body-dense">
                            {t("development.competence.withdrawnReason", {
                              reason: s.withdrawn.reason,
                            })}
                          </p>
                        </>
                      ) : (
                        <p className="m-0 text-body-dense text-text-secondary">
                          {t("development.matrix.until", { date: ukDate(s.validUntil) })}
                        </p>
                      )}
                      {may.withdraw && !s.withdrawn ? (
                        <details>
                          <summary className="inline-flex min-h-target cursor-pointer items-center underline">
                            {t("development.competence.withdraw", {
                              competence: codeLabel("development.competence.kind", s.competence, t),
                              date: ukDate(s.observedOn),
                            })}
                          </summary>
                          <div className="pt-3">
                            <DevelopmentForm
                              headingLevel={4}
                              title={t("development.competence.withdrawTitle")}
                              intro={t("development.competence.withdrawIntro")}
                              path={path}
                              submit={t("development.competence.withdrawSubmit")}
                              done="development.competence.withdrawn"
                              destructive
                              action={withdrawCompetence.bind(null, memberId, s.id)}
                              fields={[
                                {
                                  kind: "textarea",
                                  name: "reason",
                                  label: t("development.competence.reason"),
                                  hint: t("development.competence.reasonHint"),
                                  required: true,
                                  maxLength: 500,
                                },
                                {
                                  kind: "checkbox",
                                  name: "confirm",
                                  label: t("development.competence.withdrawConfirm"),
                                  required: true,
                                },
                              ]}
                            />
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {may.signOff ? (
          <Card>
            <DevelopmentForm
              headingLevel={3}
              title={t("development.competence.new")}
              intro={t("development.competence.newIntro", { name })}
              path={path}
              submit={t("development.competence.signOff")}
              done="development.competence.signedOff"
              action={signOffCompetence.bind(null, memberId)}
              fields={[
                {
                  kind: "select",
                  name: "competence",
                  label: t("development.competence.kindLabel"),
                  required: true,
                  emptyOption: t("development.form.choose"),
                  options: codeOptions(COMPETENCES, "development.competence.kind", t),
                },
                {
                  kind: "date",
                  name: "observedOn",
                  label: t("development.competence.observedOn"),
                  required: true,
                },
                {
                  kind: "checkbox",
                  name: "confirm",
                  label: t("development.competence.observedConfirm", { name }),
                  required: true,
                },
              ]}
            />
          </Card>
        ) : null}
      </section>

      <section aria-labelledby="supervision" className="flex flex-col gap-4">
        <h2 id="supervision" className="m-0 text-heading-3 font-semibold">
          {t("development.supervision.title")}
        </h2>
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
          {[
            { key: "supervision", next: record.nextSupervision },
            { key: "appraisal", next: record.nextAppraisal },
          ].map(({ key, next }) => (
            <li key={key}>
              <Card>
                <div className="flex flex-col gap-2">
                  <h3 className="m-0 text-body font-semibold">
                    {codeLabel("development.supervision.next", key, t)}
                  </h3>
                  {next ? (
                    <>
                      <p className="m-0">
                        <SafetyChip chip={meetingChip(next.state, t)} />
                      </p>
                      <p className="m-0 text-body-dense text-text-secondary">
                        {t("development.supervision.dueOn", { date: ukDate(next.dueOn) })}
                      </p>
                    </>
                  ) : (
                    <p className="m-0 text-body-dense">{t("development.supervision.noneYet")}</p>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
        {record.supervisions.length === 0 ? (
          <p className="m-0 text-body-dense">{t("development.supervision.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {record.supervisions.map((s) => (
              <li key={s.id}>
                <Card>
                  <div className="flex flex-col gap-2">
                    <h3 className="m-0 text-body font-semibold">
                      {t("development.supervision.line", {
                        kind: codeLabel("development.supervision.kind", s.kind, t),
                        date: ukDate(s.heldOn),
                        who: s.heldBy?.displayName ?? t("development.someone"),
                      })}
                    </h3>
                    {s.note ? (
                      <dl className="m-0 flex flex-col gap-2">
                        <div>
                          <dt className="font-semibold">
                            {t("development.supervision.discussion")}
                          </dt>
                          <dd className="m-0 whitespace-pre-line">{s.note.discussion}</dd>
                        </div>
                        {s.note.actions ? (
                          <div>
                            <dt className="font-semibold">
                              {t("development.supervision.actions")}
                            </dt>
                            <dd className="m-0 whitespace-pre-line">{s.note.actions}</dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {may.supervise ? (
          <Card>
            <DevelopmentForm
              headingLevel={3}
              title={t("development.supervision.new")}
              intro={t("development.supervision.newIntro", { name })}
              path={path}
              submit={t("development.supervision.record")}
              done="development.supervision.recorded"
              action={recordSupervision.bind(null, memberId)}
              fields={[
                {
                  kind: "select",
                  name: "kind",
                  label: t("development.supervision.kindLabel"),
                  required: true,
                  emptyOption: t("development.form.choose"),
                  options: codeOptions(SUPERVISION_KINDS, "development.supervision.kind", t),
                },
                {
                  kind: "date",
                  name: "heldOn",
                  label: t("development.supervision.heldOn"),
                  required: true,
                },
                {
                  kind: "textarea",
                  name: "discussion",
                  label: t("development.supervision.discussion"),
                  hint: t("development.supervision.discussionHint", { name }),
                  maxLength: 4000,
                },
                {
                  kind: "textarea",
                  name: "actions",
                  label: t("development.supervision.actions"),
                  hint: t("development.supervision.actionsHint"),
                  maxLength: 2000,
                },
              ]}
            />
          </Card>
        ) : null}
      </section>

      {plan || may.revalidation ? (
        <section aria-labelledby="revalidation" className="flex flex-col gap-4">
          <h2 id="revalidation" className="m-0 text-heading-3 font-semibold">
            {t("development.revalidation.title")}
          </h2>
          <p className="m-0 max-w-prose text-body-dense">
            {t("development.revalidation.description")}
          </p>
          {plan ? (
            <Card>
              <div className="flex flex-col gap-3">
                <p className="m-0 font-semibold">
                  {plan.daysLeft < 0
                    ? t("development.revalidation.overdue", { date: ukDate(plan.cycleDueOn) })
                    : t("development.revalidation.due", {
                        date: ukDate(plan.cycleDueOn),
                        days: plan.daysLeft,
                      })}
                </p>
                <p className="m-0">
                  <SafetyChip
                    chip={
                      plan.ready
                        ? {
                            status: "done",
                            icon: "circle-check",
                            label: t("development.revalidation.ready"),
                          }
                        : {
                            status: plan.daysLeft < 0 ? "overdue" : "due",
                            icon: plan.daysLeft < 0 ? "circle-alert" : "clock",
                            label: t("development.revalidation.notReady", {
                              count: plan.outstanding.length,
                            }),
                          }
                    }
                  />
                </p>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {REVALIDATION_REQUIREMENTS.map((requirement) => (
                    <li key={requirement} className="flex flex-wrap items-center gap-2">
                      <SafetyChip
                        chip={requirementChip(!plan.outstanding.includes(requirement), t)}
                      />
                      <span>
                        {codeLabel("development.revalidation.requirement", requirement, t)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          ) : (
            <p className="m-0 text-body-dense">{t("development.revalidation.none")}</p>
          )}
          {may.revalidation ? (
            <Card>
              <DevelopmentForm
                headingLevel={3}
                title={t("development.revalidation.new")}
                intro={t("development.revalidation.newIntro")}
                path={path}
                submit={t("development.revalidation.save")}
                done="development.revalidation.saved"
                action={saveRevalidation.bind(null, memberId, plan?.version ?? null)}
                fields={[
                  {
                    kind: "date",
                    name: "cycleDueOn",
                    label: t("development.revalidation.cycleDueOn"),
                    required: true,
                    ...(plan ? { defaultValue: plan.cycleDueOn } : {}),
                  },
                  ...(
                    [
                      ["practiceHours", plan?.practiceHours],
                      ["cpdHours", plan?.cpdHours],
                      ["participatoryCpdHours", plan?.participatoryCpdHours],
                      ["feedbackPieces", plan?.feedbackPieces],
                      ["reflectiveAccounts", plan?.reflectiveAccounts],
                    ] as const
                  ).map(([field, value]) => ({
                    kind: "text" as const,
                    name: field,
                    label: codeLabel("development.revalidation.field", field, t),
                    inputMode: "numeric" as const,
                    maxLength: 5,
                    defaultValue: String(value ?? 0),
                  })),
                  ...(
                    [
                      ["reflectiveDiscussion", plan?.reflectiveDiscussion],
                      ["healthAndCharacter", plan?.healthAndCharacter],
                      ["professionalIndemnity", plan?.professionalIndemnity],
                      ["confirmation", plan?.confirmation],
                    ] as const
                  ).map(([field, value]) => ({
                    kind: "checkbox" as const,
                    name: field,
                    label: codeLabel("development.revalidation.field", field, t),
                    defaultChecked: value === true,
                  })),
                ]}
              />
            </Card>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
