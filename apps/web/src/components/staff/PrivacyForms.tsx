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
        maxLength={40}
        error={errorFor(result, "version")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : t("privacy.notice.save")}
        </Button>
      </div>
      <StaffFeedback
        result={result}
        path="/settings/data-protection"
        fieldIds={ids}
        success={t("privacy.notice.saved")}
      />
    </form>
  );
}

/** The member acknowledges the notice version in force. */
export function AcknowledgeNoticeForm({ version }: { readonly version: string }) {
  const { result, pending, submit } = useStaffForm(
    () => ({ ok: true as const, value: version }),
    (value) => acknowledgeNotice(value),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : t("privacy.notice.acknowledge", { version })}
        </Button>
      </div>
      <StaffFeedback
        result={result}
        path={PRIVACY_PAGE}
        fieldIds={{}}
        success={t("privacy.notice.acknowledged")}
      />
    </form>
  );
}

type Purpose = StaffPrivacy["imageConsent"][number]["purpose"];

/** Give, refuse or withdraw consent for one optional use of the member's photo or image. */
export function ImageConsentForm({
  purpose,
  decision,
}: {
  readonly purpose: Purpose;
  readonly decision: StaffPrivacy["imageConsent"][number]["decision"];
}) {
  const ids = useFieldIds(["decision"] as const);
  const offered =
    decision === "given"
      ? (["withdrawn"] as const)
      : decision === "none"
        ? (["given", "refused"] as const)
        : (["given"] as const);
  const { result, pending, submit } = useStaffForm(
    (form) => {
      const chosen = String(form.get("decision") ?? "");
      return (offered as readonly string[]).includes(chosen)
        ? { ok: true as const, value: chosen }
        : {
            ok: false as const,
            problems: [{ field: "decision", message: t("privacy.image.choose") }],
          };
    },
    (value) => decideImageConsent(purpose, value),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.decision}
        name="decision"
        legend={t("privacy.image.question", { purpose })}
        options={offered.map((d) => ({
          value: d,
          label: t("privacy.image.choice", { decision: d }),
        }))}
        error={errorFor(result, "decision")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={icon}>
          {pending ? t("common.saving") : t("privacy.image.submit")}
        </Button>
      </div>
      <StaffFeedback
        result={result}
        path={PRIVACY_PAGE}
        fieldIds={ids}
        success={t("privacy.image.saved")}
      />
    </form>
  );
}
