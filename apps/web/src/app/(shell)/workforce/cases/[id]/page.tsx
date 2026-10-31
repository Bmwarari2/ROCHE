import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  addCaseNote,
  arrangeHearing,
  changeSuspension,
  decideAppeal,
  moveCase,
  nameCaseMember,
  recordReferral,
  removeCaseMember,
  updateHearing,
} from "@/app/actions/workforce";
import { SafetyChip } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  CASEWORK,
  caseStageChip,
  codeLabel,
  codeOptions,
  listOf,
  nameOf,
  present,
  ukDate,
} from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.cases.one") };

const ROLES = [
  "case_manager",
  "investigator",
  "hearing_chair",
  "appeal_chair",
  "note_taker",
  "hr_adviser",
];
const OUTCOMES: Record<string, string[]> = {
  grievance: ["upheld", "partly_upheld", "not_upheld"],
  disciplinary: [
    "no_action",
    "first_written_warning",
    "final_written_warning",
    "action_short_of_dismissal",
    "dismissal",
  ],
  capability: [
    "no_action",
    "improvement_plan",
    "first_written_warning",
    "final_written_warning",
    "redeployment",
    "dismissal",
  ],
  sickness_absence: [
    "no_action",
    "support_plan",
    "reasonable_adjustments",
    "first_written_warning",
    "final_written_warning",
    "redeployment",
    "dismissal",
  ],
  probation: ["passed", "extended", "not_passed"],
};
const CLOSING: Record<string, string[]> = {
  open: ["resolved_informally", "withdrawn", "left_employment"],
  investigation: ["resolved_informally", "no_case_to_answer", "withdrawn", "left_employment"],
  hearing: ["withdrawn", "left_employment"],
  outcome: ["outcome_accepted", "left_employment"],
  appeal: ["left_employment"],
};
const HEARING_KIND: Record<string, string> = {
  investigation: "investigation_meeting",
  hearing: "hearing",
  appeal: "appeal_hearing",
};
const LEAD_ROLE: Record<string, string> = {
  investigation_meeting: "investigator",
  hearing: "hearing_chair",
  appeal_hearing: "appeal_chair",
};

/**
 * One employee relations case (workforce.md rules 14 to 18; WORK-010): a restricted silo
 * (ADR-0089), not found for anyone not named on it. Each member is offered only their own part:
 * the case manager runs the case, the hearing chair decides the outcome, the appeal chair the
 * appeal, the member leading a hearing records it, and anyone named adds a note.
 */
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const api = await tenantApi();
  const found = await api.GET("/v1/workforce/cases/{id}", { params: { path: { id } } });
  if (!found.data) {
    if (found.response.status === 404) notFound();
    failWith(found.error, found.response, `/workforce/cases/${id}`);
  }
  const detail = found.data;
  const c = detail.case;
  const path = `/workforce/cases/${id}`;
  const roles = new Set(c.myRoles);
  const manager = roles.has("case_manager");
  const closed = c.stage === "closed";
  const named = (userId: string | null | undefined) => nameOf(present(detail.staff), userId, t);
  const active = detail.members.filter((m) => m.removedAt === null);
  // Colleagues to name come from the directory, open to holders of the silo permission; a case
  // manager without it can still remove members and run the case.
  const colleagues =
    manager && !closed && me.permissions.includes(CASEWORK)
      ? await api.GET("/v1/workforce/colleagues")
      : null;
  const people = present(colleagues?.data?.items)
    .filter((p) => p.id !== c.subjectTenantUserId && p.id !== me.tenantUserId)
    .map((p) => ({ value: p.id, label: p.displayName }));
  const hearingKind = HEARING_KIND[c.stage];
  const leaders = hearingKind
    ? active
        .filter((m) => m.role === LEAD_ROLE[hearingKind])
        .map((m) => ({ value: m.tenantUserId, label: named(m.tenantUserId) }))
    : [];
  const v = c.version;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("workforce.cases.title")}
        title={t("workforce.cases.caseOf", {
          type: codeLabel("workforce.cases.type", c.caseType, t),
          name: c.subjectName ?? t("workforce.someone"),
        })}
        description={t("workforce.cases.openedOn", { date: ukDate(c.openedOn) })}
      />
      <Card>
        <div className="flex flex-col gap-2">
          <p className="m-0 flex flex-wrap gap-2">
            <SafetyChip chip={caseStageChip(c.stage, t)} />
            {c.suspended ? (
              <SafetyChip
                chip={
                  c.suspensionReviewOverdue
                    ? {
                        status: "overdue",
                        icon: "circle-alert",
                        label: t("workforce.cases.suspensionOverdue"),
                      }
                    : {
                        status: "info",
                        icon: "circle-alert",
                        label: t("workforce.cases.suspended"),
                      }
                }
              />
            ) : null}
          </p>
          <p className="m-0 max-w-prose whitespace-pre-line">{c.summary}</p>
          <p className="m-0 text-body-dense text-text-secondary">
            {t("workforce.cases.myRoles", {
              roles: listOf(c.myRoles.map((r) => codeLabel("workforce.cases.role", r, t))),
            })}
          </p>
          {detail.daysAtStage !== null ? (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("workforce.cases.daysAtStage", { count: detail.daysAtStage })}
            </p>
          ) : null}
          {c.outcome ? (
            <p className="m-0 text-body-dense">
              {t("workforce.cases.outcomeLine", {
                outcome: codeLabel("workforce.cases.outcome", c.outcome, t),
                date: ukDate(c.outcomeDecidedOn),
              })}
            </p>
          ) : null}
          {c.appealOutcome ? (
            <p className="m-0 text-body-dense">
              {t("workforce.cases.appealLine", {
                outcome: codeLabel("workforce.cases.appealOutcome", c.appealOutcome, t),
              })}
            </p>
          ) : null}
          {(["dbs", "regulator"] as const).map((body) =>
            detail.referrals[body].due || detail.referrals[body].decision ? (
              <p key={body} className="m-0 text-body-dense">
                {t("workforce.cases.referralLine", {
                  body: codeLabel("workforce.cases.referralBody", body, t),
                  decision: detail.referrals[body].decision
                    ? codeLabel("workforce.cases.referral", detail.referrals[body].decision, t)
                    : t("workforce.cases.referralDue"),
                })}
              </p>
            ) : null,
          )}
        </div>
      </Card>

      <section aria-labelledby="members" className="flex flex-col gap-3">
        <h2 id="members" className="m-0 text-heading-3 font-semibold">
          {t("workforce.cases.members")}
        </h2>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {active.map((m) => (
            <li key={m.id}>
              <Card>
                <div className="flex flex-col gap-2">
                  <span>
                    {t("workforce.cases.memberLine", {
                      name: named(m.tenantUserId),
                      role: codeLabel("workforce.cases.role", m.role, t),
                    })}
                  </span>
                  {manager && !closed && m.tenantUserId !== me.tenantUserId ? (
                    <WorkforceForm
                      headingLevel={3}
                      title={t("workforce.cases.removeMember", { name: named(m.tenantUserId) })}
                      intro={t("workforce.cases.removeIntro")}
                      path={path}
                      submit={t("workforce.cases.removeSubmit", { name: named(m.tenantUserId) })}
                      done="workforce.cases.removed"
                      destructive
                      action={removeCaseMember.bind(null, id, m.id, m.version)}
                      fields={[
                        {
                          kind: "checkbox",
                          name: "confirm",
                          label: t("workforce.cases.removeConfirm", {
                            name: named(m.tenantUserId),
                          }),
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
        {manager && !closed ? (
          <Card>
            <WorkforceForm
              headingLevel={3}
              title={t("workforce.cases.nameMember")}
              intro={t("workforce.cases.nameMemberIntro")}
              path={path}
              submit={t("workforce.cases.nameSubmit")}
              done="workforce.cases.named"
              action={nameCaseMember.bind(null, id)}
              fields={[
                {
                  kind: "select",
                  name: "tenantUserId",
                  label: t("workforce.cases.memberLabel"),
                  required: true,
                  emptyOption: t("workforce.form.choose"),
                  options: people,
                },
                {
                  kind: "select",
                  name: "role",
                  label: t("workforce.cases.roleLabel"),
                  required: true,
                  emptyOption: t("workforce.form.choose"),
                  options: codeOptions(ROLES, "workforce.cases.role", t),
                },
                { kind: "checkbox", name: "exception", label: t("workforce.cases.exception") },
              ]}
            />
          </Card>
        ) : null}
      </section>

      {detail.hearings.length > 0 ? (
        <section aria-labelledby="hearings" className="flex flex-col gap-3">
          <h2 id="hearings" className="m-0 text-heading-3 font-semibold">
            {t("workforce.cases.hearings")}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {detail.hearings.map((h) => {
              const mayUpdate =
                (manager || h.ledBy === me.tenantUserId) &&
                (h.state === "scheduled" || h.state === "postponed");
              return (
                <li key={h.id}>
                  <Card>
                    <div className="flex flex-col gap-2">
                      <span>
                        {t("workforce.cases.hearingLine", {
                          kind: codeLabel("workforce.cases.hearingKind", h.kind, t),
                          date: ukDate(h.scheduledAt),
                          lead: named(h.ledBy),
                          state: codeLabel("workforce.cases.hearingState", h.state, t),
                        })}
                      </span>
                      {mayUpdate ? (
                        <WorkforceForm
                          headingLevel={3}
                          title={t("workforce.cases.hearingRecord", {
                            kind: codeLabel("workforce.cases.hearingKind", h.kind, t),
                            date: ukDate(h.scheduledAt),
                          })}
                          path={path}
                          submit={t("workforce.cases.hearingRecordSubmit", {
                            kind: codeLabel("workforce.cases.hearingKind", h.kind, t),
                          })}
                          done="workforce.cases.hearingRecorded"
                          action={updateHearing.bind(null, id, h.id, h.version)}
                          fields={[
                            {
                              kind: "select",
                              name: "state",
                              label: t("workforce.cases.hearingStateLabel"),
                              required: true,
                              emptyOption: t("workforce.form.choose"),
                              options: codeOptions(
                                ["held", "not_attended", "postponed", "cancelled"],
                                "workforce.cases.hearingState",
                                t,
                              ),
                            },
                            {
                              kind: "date",
                              name: "heldOn",
                              label: t("workforce.cases.heldOn"),
                              hint: t("workforce.cases.heldOnHint"),
                            },
                            {
                              kind: "checkbox",
                              name: "accompanied",
                              label: t("workforce.cases.accompanied"),
                            },
                            {
                              kind: "select",
                              name: "postponedReason",
                              label: t("workforce.cases.postponedReason"),
                              emptyOption: t("workforce.form.choose"),
                              options: codeOptions(
                                [
                                  "companion_unavailable",
                                  "employee_unwell",
                                  "employer_request",
                                  "other",
                                ],
                                "workforce.cases.postponed",
                                t,
                              ),
                            },
                          ]}
                        />
                      ) : null}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {manager && !closed ? (
        <section aria-labelledby="run-case" className="flex flex-col gap-3">
          <h2 id="run-case" className="m-0 text-heading-3 font-semibold">
            {t("workforce.cases.run")}
          </h2>
          {c.stage === "open" ? (
            <Card>
              <WorkforceForm
                headingLevel={3}
                title={t("workforce.cases.startInvestigation")}
                path={path}
                submit={t("workforce.cases.startInvestigationSubmit")}
                done="workforce.cases.moved"
                action={moveCase.bind(null, id, v, "investigation")}
                fields={[
                  { kind: "date", name: "on", label: t("workforce.cases.on"), required: true },
                ]}
              />
            </Card>
          ) : null}
          {c.stage === "open" || c.stage === "investigation" ? (
            <Card>
              <WorkforceForm
                headingLevel={3}
                title={t("workforce.cases.toHearing")}
                path={path}
                submit={t("workforce.cases.toHearingSubmit")}
                done="workforce.cases.moved"
                action={moveCase.bind(null, id, v, "hearing")}
                fields={[
                  { kind: "date", name: "on", label: t("workforce.cases.on"), required: true },
                ]}
              />
            </Card>
          ) : null}
          {hearingKind ? (
            <Card>
              <WorkforceForm
                headingLevel={3}
                title={t("workforce.cases.arrange", {
                  kind: codeLabel("workforce.cases.hearingKind", hearingKind, t),
                })}
                intro={t("workforce.cases.arrangeIntro")}
                path={path}
                submit={t("workforce.cases.arrangeSubmit")}
                done="workforce.cases.arranged"
                action={arrangeHearing.bind(null, id, hearingKind)}
                fields={[
                  {
                    kind: "select",
                    name: "ledBy",
                    label: t("workforce.cases.ledBy"),
                    hint: t("workforce.cases.ledByHint"),
                    required: true,
                    emptyOption: t("workforce.form.choose"),
                    options: leaders,
                  },
                  {
                    kind: "date",
                    name: "invitedOn",
                    label: t("workforce.cases.invitedOn"),
                    required: true,
                  },
                  {
                    kind: "date",
                    name: "scheduledOn",
                    label: t("workforce.cases.scheduledOn"),
                    required: true,
                  },
                  {
                    kind: "text",
                    name: "scheduledTime",
                    label: t("workforce.cases.scheduledTime"),
                    hint: t("workforce.cases.scheduledTimeHint"),
                    required: true,
                    maxLength: 5,
                  },
                  {
                    kind: "checkbox",
                    name: "issueSetOut",
                    label: t("workforce.cases.issueSetOut"),
                  },
                  {
                    kind: "checkbox",
                    name: "evidenceShared",
                    label: t("workforce.cases.evidenceShared"),
                  },
                  {
                    kind: "checkbox",
                    name: "companionRightGiven",
                    label: t("workforce.cases.companionRightGiven"),
                  },
                ]}
              />
            </Card>
          ) : null}
          {c.stage === "outcome" ? (
            <Card>
              <WorkforceForm
                headingLevel={3}
                title={t("workforce.cases.lodgeAppeal")}
                path={path}
                submit={t("workforce.cases.lodgeAppealSubmit")}
                done="workforce.cases.moved"
                action={moveCase.bind(null, id, v, "appeal")}
                fields={[
                  { kind: "date", name: "on", label: t("workforce.cases.on"), required: true },
                  {
                    kind: "textarea",
                    name: "grounds",
                    label: t("workforce.cases.grounds"),
                    required: true,
                    maxLength: 10000,
                  },
                ]}
              />
            </Card>
          ) : null}
          {c.caseType === "disciplinary" ? (
            <Card>
              {c.suspended ? (
                <>
                  <WorkforceForm
                    headingLevel={3}
                    title={t("workforce.cases.reviewSuspension")}
                    path={path}
                    submit={t("workforce.cases.reviewSuspensionSubmit")}
                    done="workforce.cases.suspensionSaved"
                    action={changeSuspension.bind(null, id, v, "review")}
                    fields={[
                      { kind: "date", name: "on", label: t("workforce.cases.on"), required: true },
                      {
                        kind: "date",
                        name: "reviewOn",
                        label: t("workforce.cases.nextReview"),
                        required: true,
                      },
                    ]}
                  />
                  <WorkforceForm
                    headingLevel={3}
                    title={t("workforce.cases.endSuspension")}
                    path={path}
                    submit={t("workforce.cases.endSuspensionSubmit")}
                    done="workforce.cases.suspensionSaved"
                    action={changeSuspension.bind(null, id, v, "end")}
                    fields={[
                      { kind: "date", name: "on", label: t("workforce.cases.on"), required: true },
                    ]}
                  />
                </>
              ) : (
                <WorkforceForm
                  headingLevel={3}
                  title={t("workforce.cases.suspend")}
                  intro={t("workforce.cases.suspendIntro")}
                  path={path}
                  submit={t("workforce.cases.suspendSubmit")}
                  done="workforce.cases.suspensionSaved"
                  action={changeSuspension.bind(null, id, v, "start")}
                  fields={[
                    { kind: "date", name: "on", label: t("workforce.cases.on"), required: true },
                    {
                      kind: "date",
                      name: "reviewOn",
                      label: t("workforce.cases.nextReview"),
                      required: true,
                    },
                  ]}
                />
              )}
            </Card>
          ) : null}
          {(["dbs", "regulator"] as const).map((body) =>
            detail.referrals[body].due && !detail.referrals[body].decision ? (
              <Card key={body}>
                <WorkforceForm
                  headingLevel={3}
                  title={t("workforce.cases.referralRecord", {
                    body: codeLabel("workforce.cases.referralBody", body, t),
                  })}
                  intro={t("workforce.cases.referralIntro")}
                  path={path}
                  submit={t("workforce.cases.referralSubmit")}
                  done="workforce.cases.referralSaved"
                  action={recordReferral.bind(null, id, v, body)}
                  fields={[
                    {
                      kind: "select",
                      name: "decision",
                      label: t("workforce.cases.referralDecision"),
                      required: true,
                      emptyOption: t("workforce.form.choose"),
                      options: codeOptions(
                        ["referred", "not_required"],
                        "workforce.cases.referral",
                        t,
                      ),
                    },
                    { kind: "date", name: "referredOn", label: t("workforce.cases.referredOn") },
                    {
                      kind: "select",
                      name: "reason",
                      label: t("workforce.cases.referralReason"),
                      emptyOption: t("workforce.form.choose"),
                      options: codeOptions(
                        [
                          "harm_test_not_met",
                          "not_regulated_activity",
                          "referred_by_another_body",
                          "other_recorded_in_case",
                        ],
                        "workforce.cases.referralNotRequired",
                        t,
                      ),
                    },
                  ]}
                />
              </Card>
            ) : null,
          )}
          {CLOSING[c.stage] ? (
            <Card>
              <WorkforceForm
                headingLevel={3}
                title={t("workforce.cases.close")}
                intro={t("workforce.cases.closeIntro")}
                path={path}
                submit={t("workforce.cases.closeSubmit")}
                done="workforce.cases.closed"
                destructive
                action={moveCase.bind(null, id, v, "closed")}
                fields={[
                  { kind: "date", name: "on", label: t("workforce.cases.on"), required: true },
                  {
                    kind: "select",
                    name: "reason",
                    label: t("workforce.cases.closeReason"),
                    required: true,
                    emptyOption: t("workforce.form.choose"),
                    options: codeOptions(CLOSING[c.stage] ?? [], "workforce.cases.closing", t),
                  },
                  {
                    kind: "checkbox",
                    name: "confirm",
                    label: t("workforce.cases.closeConfirm"),
                    required: true,
                  },
                ]}
              />
            </Card>
          ) : null}
        </section>
      ) : null}

      {roles.has("hearing_chair") && c.stage === "hearing" ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.cases.decide")}
            intro={t("workforce.cases.decideIntro")}
            path={path}
            submit={t("workforce.cases.decideSubmit")}
            done="workforce.cases.moved"
            action={moveCase.bind(null, id, v, "outcome")}
            fields={[
              { kind: "date", name: "on", label: t("workforce.cases.decidedOn"), required: true },
              {
                kind: "select",
                name: "outcome",
                label: t("workforce.cases.outcomeLabel"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options: codeOptions(OUTCOMES[c.caseType] ?? [], "workforce.cases.outcome", t),
              },
              {
                kind: "date",
                name: "warningExpiresOn",
                label: t("workforce.cases.warningExpires"),
                hint: t("workforce.cases.warningExpiresHint"),
              },
              {
                kind: "checkbox",
                name: "appealRightGiven",
                label: t("workforce.cases.appealRightGiven"),
                required: true,
              },
              { kind: "checkbox", name: "noHearing", label: t("workforce.cases.noHearing") },
            ]}
          />
        </Card>
      ) : null}

      {roles.has("appeal_chair") && c.stage === "appeal" ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.cases.decideAppeal")}
            path={path}
            submit={t("workforce.cases.decideAppealSubmit")}
            done="workforce.cases.moved"
            action={decideAppeal.bind(null, id, v)}
            fields={[
              { kind: "date", name: "on", label: t("workforce.cases.decidedOn"), required: true },
              {
                kind: "select",
                name: "appealOutcome",
                label: t("workforce.cases.appealOutcomeLabel"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options: codeOptions(
                  ["upheld", "partly_upheld", "not_upheld"],
                  "workforce.cases.appealOutcome",
                  t,
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      <section aria-labelledby="timeline" className="flex flex-col gap-3">
        <h2 id="timeline" className="m-0 text-heading-3 font-semibold">
          {t("workforce.cases.timeline")}
        </h2>
        <Card>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {detail.timeline.map((e) => (
              <li key={e.id} className="flex flex-col gap-1">
                <span className="text-body-dense text-text-secondary">
                  {t("workforce.cases.eventLine", {
                    date: ukDate(e.occurredOn),
                    who: named(e.recordedBy),
                    kind: codeLabel("workforce.cases.event", e.kind, t),
                  })}
                </span>
                {e.body ? <span className="max-w-prose whitespace-pre-line">{e.body}</span> : null}
              </li>
            ))}
          </ol>
        </Card>
        {!closed ? (
          <Card>
            <WorkforceForm
              headingLevel={3}
              title={t("workforce.cases.note")}
              path={path}
              submit={t("workforce.cases.noteSubmit")}
              done="workforce.cases.noteAdded"
              action={addCaseNote.bind(null, id)}
              fields={[
                {
                  kind: "date",
                  name: "occurredOn",
                  label: t("workforce.cases.noteOn"),
                  required: true,
                },
                {
                  kind: "textarea",
                  name: "body",
                  label: t("workforce.cases.noteBody"),
                  required: true,
                  maxLength: 10000,
                },
              ]}
            />
          </Card>
        ) : null}
      </section>
    </div>
  );
}
