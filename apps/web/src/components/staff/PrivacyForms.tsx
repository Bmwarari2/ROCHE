"use client";

import { Button, RadioGroup, TextField } from "@harbour/ui";
import { Save } from "lucide-react";
import { acknowledgeNotice, decideImageConsent, setNoticeVersion } from "@/app/actions/staff";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { errorFor } from "@/lib/outcome";
import { PRIVACY_PAGE, readNoticeVersion, type StaffPrivacy } from "@/lib/staff";
import { StaffFeedback } from "./StaffForms";
import { useStaffForm } from "./use-staff-form";

const icon = <Save size={18} strokeWidth={1.5} aria-hidden="true" />;
const VERSION_FIELDS = ["version"] as const;

/** The organisation's staff privacy notice version in force (platform.tenant.manage). */
export function NoticeVersionForm({ current }: { readonly current: string | null }) {
  const ids = useFieldIds(VERSION_FIELDS);
  const { result, pending, submit } = useStaffForm(
    (form) => readNoticeVersion(form, t),
    (value) => setNoticeVersion(value),
    { done: "notice" },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.version}
        name="version"
        label={t("privacy.notice.version")}
        hint={t("privacy.notice.versionHint")}
        defaultValue={current ?? ""}
        autoComplete="off"
        error={errorFor(result, "version")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : t("privacy.notice.save")}
        </Button>
      </div>
      <StaffFeedback result={result} path="/settings/data-protection" fieldIds={ids} />
    </form>
  );
}

/** The member acknowledges the notice version in force. */
export function AcknowledgeNoticeForm({ version }: { readonly version: string }) {
  const { result, pending, submit } = useStaffForm(
    () => ({ ok: true as const, value: version }),
    (value) => acknowledgeNotice(value),
    { done: "acknowledged" },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : t("privacy.notice.acknowledge", { version })}
        </Button>
      </div>
      <StaffFeedback result={result} path={PRIVACY_PAGE} fieldIds={{}} />
    </form>
  );
}

type Purpose = StaffPrivacy["imageConsent"][number]["purpose"];

/**
 * One optional use of the member's photo or image. Asked for the first time: yes or no. Once
 * answered: one button that changes the answer, saying what it does (withdrawing stops new use).
 */
export function ImageConsentForm({
  purpose,
  decision,
}: {
  readonly purpose: Purpose;
  readonly decision: StaffPrivacy["imageConsent"][number]["decision"];
}) {
  const ids = useFieldIds(["decision"] as const);
  const first = decision === "none";
  const change = decision === "given" ? "withdrawn" : "given";
  const { result, pending, submit } = useStaffForm(
    (form) => {
      if (!first) return { ok: true as const, value: change };
      const chosen = String(form.get("decision") ?? "");
      return chosen === "given" || chosen === "refused"
        ? { ok: true as const, value: chosen }
        : {
            ok: false as const,
            problems: [{ field: "decision", message: t("privacy.image.choose") }],
          };
    },
    (value) => decideImageConsent(purpose, value),
    { done: `consent-${purpose}` },
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      {first ? (
        <RadioGroup
          id={ids.decision}
          name="decision"
          legend={t("privacy.image.question", { purpose })}
          options={(["given", "refused"] as const).map((d) => ({
            value: d,
            label: t("privacy.image.choice", { decision: d }),
          }))}
          error={errorFor(result, "decision")}
        />
      ) : (
        <p className="m-0">{t("privacy.image.effect", { change, purpose })}</p>
      )}
      <div>
        <Button
          type="submit"
          disabled={pending}
          icon={icon}
          variant={change === "withdrawn" && !first ? "secondary" : "primary"}
        >
          {pending
            ? t("common.saving")
            : first
              ? t("privacy.image.submit")
              : t("privacy.image.change", { change, purpose })}
        </Button>
      </div>
      <StaffFeedback result={result} path={PRIVACY_PAGE} fieldIds={ids} />
    </form>
  );
}
