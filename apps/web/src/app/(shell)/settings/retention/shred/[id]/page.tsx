import { Card, PageHeader, StatusChip } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ApproveShredForm,
  CancelShredForm,
  RefuseShredForm,
} from "@/components/retention/ShredForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";
import { retentionShown } from "@/lib/retention";
import {
  certificateHref,
  memberName,
  SHRED_PAGE,
  shredActions,
  shredChip,
  shredHref,
  shredState,
} from "@/lib/shred";

export const metadata: Metadata = { title: t("shred.detail.title") };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DONE = new Set(["requested", "approved", "refused", "cancelled", "withdrawn"]);

/**
 * One shred request (PLAT-012 part 2; platform.md rules 8 to 10): its state as an icon and a word,
 * who asked and who decided, when it lapses, the reason and any refusal reason, and its
 * certificate. Another holder approves (after the consequences again, a typed word and the
 * acknowledgement) or refuses (with a reason) while it waits; the requester may cancel it; anyone
 * may withdraw it once it has lapsed. The API decides every rule again.
 */
export default async function ShredRequestPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("shred.detail.title");
  if (!retentionShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/retention/shred-requests");
  if (!listed.data) failWith(listed.error, listed.response, shredHref(id));
  const item = listed.data.items.find((i) => i.id === id);
  if (!item) notFound();
  const state = shredState(item);
  const chip = shredChip(state, t);
  const can = shredActions(item, me.tenantUserId);
  const when = (iso: string | null) => formatDateTime(iso) ?? "";
  const query = await searchParams;
  const done = firstParam(query.done);
  const arrival =
    done && DONE.has(done) ? t("shred.done", { done, state: firstParam(query.state) ?? "" }) : null;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("shred.list.heading", { when: when(item.requestedAt) })}
      />
      {arrival ? <RecordedArrival message={arrival} param="done" /> : null}
      <Card as="section" title={t("shred.detail.about")} headingLevel={2}>
        <dl className="m-0 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <dt className="text-body-dense font-semibold">{t("shred.detail.state")}</dt>
            <dd className="m-0">
              <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-body-dense font-semibold">{t("shred.detail.requested")}</dt>
            <dd className="m-0">
              {t("shred.detail.byWhen", {
                name: memberName(item.requestedByName, t),
                when: when(item.requestedAt),
              })}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-body-dense font-semibold">{t("shred.detail.reason")}</dt>
            <dd className="m-0 whitespace-pre-wrap break-words">{item.reason}</dd>
          </div>
          {item.status === "pending" ? (
            <div className="flex flex-col gap-1">
              <dt className="text-body-dense font-semibold">{t("shred.detail.lapses")}</dt>
              <dd className="m-0">{when(item.expiresAt)}</dd>
            </div>
          ) : null}
          {item.decidedAt ? (
            <div className="flex flex-col gap-1">
              <dt className="text-body-dense font-semibold">
                {t("shred.detail.decided", { state })}
              </dt>
              <dd className="m-0">
                {t("shred.detail.byWhen", {
                  name: memberName(item.decidedByName, t),
                  when: when(item.decidedAt),
                })}
              </dd>
            </div>
          ) : null}
          {item.decisionReason ? (
            <div className="flex flex-col gap-1">
              <dt className="text-body-dense font-semibold">{t("shred.detail.refusalReason")}</dt>
              <dd className="m-0 whitespace-pre-wrap break-words">{item.decisionReason}</dd>
            </div>
          ) : null}
        </dl>
        {item.certificateId ? (
          <p className="m-0 mt-4">
            <Link
              href={certificateHref(item.certificateId)}
              className="inline-flex min-h-target items-center underline"
            >
              {t("shred.detail.certificate")}
            </Link>
          </p>
        ) : null}
      </Card>
      {can.decide ? (
        <>
          <p className="m-0">{t("shred.decide.both")}</p>
          <Card as="section" title={t("shred.refuse.title")} headingLevel={2}>
            <RefuseShredForm id={item.id} />
          </Card>
          <Card as="section" title={t("shred.approve.title")} headingLevel={2}>
            <ApproveShredForm id={item.id} organisation={me.tenant.name} />
          </Card>
        </>
      ) : null}
      {can.cancel || can.withdraw ? (
        <Card
          as="section"
          title={t("shred.cancel.title", { kind: can.cancel ? "cancel" : "withdraw" })}
          headingLevel={2}
        >
          <div className="flex flex-col gap-3">
            <p className="m-0">
              {t("shred.cancel.about", { kind: can.cancel ? "cancel" : "withdraw" })}
            </p>
            <CancelShredForm id={item.id} kind={can.cancel ? "cancel" : "withdraw"} />
          </div>
        </Card>
      ) : null}
      {item.status === "pending" && !item.lapsed && !can.decide ? (
        <p className="m-0">{t("shred.approve.ownRequest")}</p>
      ) : null}
      <p className="m-0">
        <Link href={SHRED_PAGE} className="inline-flex min-h-target items-center underline">
          {t("shred.back")}
        </Link>
      </p>
    </div>
  );
}
