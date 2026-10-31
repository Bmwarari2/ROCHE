import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  answerReferenceRequest,
  endLeaverAccess,
  recordExitInterview,
  recordLeaving,
  recordReferenceRequest,
  tickLeaverItem,
} from "@/app/actions/workforce";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  checklistChip,
  codeLabel,
  codeOptions,
  STAFF_FILE_MANAGE,
  staffShown,
  ukDate,
} from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.leaving.title") };

const REASONS = [
  "resignation",
  "end_of_fixed_term",
  "retirement",
  "dismissal",
  "redundancy",
  "tupe_transfer_out",
  "death_in_service",
  "other",
];
const TICKED = new Set(["property_returned", "final_pay_notified"]);

/**
 * A member of staff leaving (workforce.md rules 22 and 23; WORK-013): the leaving date and reason,
 * the checklist, the exit interview, references and how long the staff file is kept. Access ends
 * the day after the leaving date, or at once with step-up.
 */
export default async function LeavingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("workforce.leaving.title");
  if (!staffShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const [found, files] = await Promise.all([
    api.GET("/v1/workforce/staff-files/{id}/leaving", { params: { path: { id } } }),
    api.GET("/v1/workforce/staff-files"),
  ]);
  const file = files.data?.items.find((f) => f.id === id);
  if (!file) {
    if (!files.data) failWith(files.error, files.response, `/workforce/staff/${id}/leaving`);
    notFound();
  }
  const leaving = found.data ?? null;
  if (!leaving && found.response.status !== 404) {
    failWith(found.error, found.response, `/workforce/staff/${id}/leaving`);
  }
  const manages = me.permissions.includes(STAFF_FILE_MANAGE) && file.member?.id !== me.tenantUserId;
  const path = `/workforce/staff/${id}/leaving`;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("workforce.staff.title")}
        title={t("workforce.leaving.heading", {
          name: file.member?.displayName ?? t("workforce.someone"),
        })}
        description={
          leaving
            ? t("workforce.leaving.leavingOn", {
                date: ukDate(leaving.leavingOn),
                reason: codeLabel("workforce.leaving.reason", leaving.reason, t),
              })
            : t("workforce.leaving.notLeaving")
        }
      />
      {!leaving ? (
        manages ? (
          <Card>
            <WorkforceForm
              headingLevel={2}
              title={t("workforce.leaving.record")}
              intro={t("workforce.leaving.recordIntro")}
              path={path}
              submit={t("workforce.leaving.recordSubmit")}
              done={t("workforce.leaving.recorded")}
              action={recordLeaving.bind(null, id)}
              fields={[
                {
                  kind: "date",
                  name: "leavingOn",
                  label: t("workforce.leaving.lastDay"),
                  required: true,
                },
                {
                  kind: "select",
                  name: "reason",
                  label: t("workforce.leaving.reasonLabel"),
                  required: true,
                  emptyOption: t("workforce.form.choose"),
                  options: codeOptions(REASONS, "workforce.leaving.reason", t),
                },
              ]}
            />
          </Card>
        ) : null
      ) : (
        <>
          <Card>
            <p className="m-0 text-body-dense">
              {leaving.accessRemovedAt
                ? t("workforce.leaving.accessEnded")
                : t("workforce.leaving.accessEnds", { date: ukDate(leaving.leavingOn) })}
            </p>
            <p className="m-0 mt-2 text-body-dense">
              {leaving.staffFileRetainUntil
                ? t("workforce.leaving.keptUntil", { date: ukDate(leaving.staffFileRetainUntil) })
                : t("workforce.leaving.keptUndecided")}
            </p>
          </Card>
          <section aria-labelledby="leaving-checklist" className="flex flex-col gap-3">
            <h2 id="leaving-checklist" className="m-0 text-heading-3 font-semibold">
              {t("workforce.leaving.checklist")}
            </h2>
            <Card>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {leaving.checklist.map((item) => (
                  <li
                    key={item.kind}
                    className="flex flex-col gap-2 border-b border-border pb-3 last:border-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{codeLabel("workforce.leaving.item", item.kind, t)}</span>
                      <SafetyChip chip={checklistChip(item.status, t)} />
                    </div>
                    {manages && TICKED.has(item.kind) && item.status !== "done" ? (
                      <WorkforceForm
                        headingLevel={3}
                        title={t("workforce.induction.tick", {
                          item: codeLabel("workforce.leaving.item", item.kind, t),
                        })}
                        path={path}
                        submit={t("workforce.induction.tickSubmit")}
                        done={t("workforce.induction.ticked")}
                        action={tickLeaverItem.bind(null, id, item.kind)}
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
            </Card>
          </section>
          {manages && !leaving.accessRemovedAt ? (
            <Card>
              <WorkforceForm
                headingLevel={2}
                title={t("workforce.leaving.endAccess")}
                intro={t("workforce.leaving.endAccessIntro")}
                path={path}
                submit={t("workforce.leaving.endAccessSubmit")}
                done={t("workforce.leaving.accessEndedNow")}
                destructive
                action={endLeaverAccess.bind(null, id)}
                fields={[
                  {
                    kind: "checkbox",
                    name: "confirm",
                    label: t("workforce.leaving.endAccessConfirm"),
                    required: true,
                  },
                ]}
              />
            </Card>
          ) : null}
          <section aria-labelledby="exit-interview" className="flex flex-col gap-3">
            <h2 id="exit-interview" className="m-0 text-heading-3 font-semibold">
              {t("workforce.leaving.exitInterview")}
            </h2>
            <Card>
              <p className="m-0 text-body-dense">
                {codeLabel("workforce.leaving.exit", leaving.exitInterview, t)}
              </p>
              {leaving.exitInterviewSummary ? (
                <p className="m-0 mt-2 max-w-prose whitespace-pre-line">
                  {leaving.exitInterviewSummary}
                </p>
              ) : null}
            </Card>
            {manages &&
            (leaving.exitInterview === "not_offered" || leaving.exitInterview === "offered") ? (
              <Card>
                <WorkforceForm
                  headingLevel={3}
                  title={t("workforce.leaving.exitRecord")}
                  intro={t("workforce.leaving.exitIntro")}
                  path={path}
                  submit={t("workforce.leaving.exitSubmit")}
                  done={t("workforce.leaving.exitRecorded")}
                  action={recordExitInterview.bind(null, id, leaving.version)}
                  fields={[
                    {
                      kind: "select",
                      name: "state",
                      label: t("workforce.leaving.exitState"),
                      required: true,
                      emptyOption: t("workforce.form.choose"),
                      options: codeOptions(
                        leaving.exitInterview === "offered"
                          ? ["declined", "held"]
                          : ["offered", "declined", "held"],
                        "workforce.leaving.exit",
                        t,
                      ),
                    },
                    {
                      kind: "date",
                      name: "heldOn",
                      label: t("workforce.leaving.exitHeldOn"),
                      hint: t("workforce.leaving.exitHeldOnHint"),
                    },
                    {
                      kind: "textarea",
                      name: "summary",
                      label: t("workforce.leaving.exitSummary"),
                      hint: t("workforce.leaving.exitSummaryHint"),
                      maxLength: 4000,
                    },
                  ]}
                />
              </Card>
            ) : null}
          </section>
          <section aria-labelledby="references" className="flex flex-col gap-3">
            <h2 id="references" className="m-0 text-heading-3 font-semibold">
              {t("workforce.references.title")}
            </h2>
            {leaving.references.length === 0 ? (
              <p className="m-0 text-body-dense">{t("workforce.references.empty")}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {leaving.references.map((r) => (
                  <li key={r.id}>
                    <Card>
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">{r.requester}</span>
                          <SafetyChip
                            chip={
                              r.state === "requested"
                                ? {
                                    status: "due",
                                    icon: "clock",
                                    label: t("workforce.references.state.requested"),
                                  }
                                : r.state === "sent"
                                  ? {
                                      status: "done",
                                      icon: "send",
                                      label: t("workforce.references.state.sent"),
                                    }
                                  : {
                                      status: "notApplicable",
                                      icon: "circle-minus",
                                      label: t("workforce.references.state.declined"),
                                    }
                            }
                          />
                        </div>
                        <span className="text-body-dense text-text-secondary">
                          {t("workforce.references.line", {
                            kind: codeLabel("workforce.references.kind", r.kind, t),
                            date: ukDate(r.requestedOn),
                          })}
                        </span>
                        {manages && r.state === "requested" ? (
                          <WorkforceForm
                            headingLevel={4}
                            title={t("workforce.references.answer", { requester: r.requester })}
                            path={path}
                            submit={t("workforce.references.answerSubmit")}
                            done={t("workforce.references.answered")}
                            action={answerReferenceRequest.bind(null, id, r.id, r.version)}
                            fields={[
                              {
                                kind: "select",
                                name: "state",
                                label: t("workforce.references.answerLabel"),
                                required: true,
                                emptyOption: t("workforce.form.choose"),
                                options: codeOptions(
                                  ["sent", "declined"],
                                  "workforce.references.state",
                                  t,
                                ),
                              },
                              {
                                kind: "date",
                                name: "sentOn",
                                label: t("workforce.references.sentOn"),
                              },
                              {
                                kind: "select",
                                name: "declinedReason",
                                label: t("workforce.references.declinedReason"),
                                emptyOption: t("workforce.form.choose"),
                                options: codeOptions(
                                  ["no_consent_to_share", "not_employed_here", "duplicate_request"],
                                  "workforce.references.declined",
                                  t,
                                ),
                              },
                            ]}
                          />
                        ) : null}
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
            {manages ? (
              <Card>
                <WorkforceForm
                  headingLevel={3}
                  title={t("workforce.references.new")}
                  intro={t("workforce.references.newIntro")}
                  path={path}
                  submit={t("workforce.references.record")}
                  done={t("workforce.references.recorded")}
                  action={recordReferenceRequest.bind(null, id)}
                  fields={[
                    {
                      kind: "date",
                      name: "requestedOn",
                      label: t("workforce.references.requestedOn"),
                      required: true,
                    },
                    {
                      kind: "text",
                      name: "requester",
                      label: t("workforce.references.requester"),
                      hint: t("workforce.references.requesterHint"),
                      required: true,
                      maxLength: 200,
                    },
                    {
                      kind: "select",
                      name: "kind",
                      label: t("workforce.references.kindLabel"),
                      required: true,
                      emptyOption: t("workforce.form.choose"),
                      options: codeOptions(["factual", "conduct"], "workforce.references.kind", t),
                    },
                  ]}
                />
              </Card>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
