"use client";

import type { AssignableRole } from "@harbour/contracts";
import { Button, SelectField, TextField } from "@harbour/ui";
import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { addAndInvite } from "@/app/actions/team";
import { useEntryId, useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import { ORGANISATION, readInvite } from "@/lib/team";

const FIELDS = ["displayName", "email", "roleId", "locationId"] as const;

/**
 * Invite someone (PLAT-004): their name, work address, one role and where it applies. Only the
 * roles the manager may give are offered, each only where they may give it; the form checks the
 * fields with the API's own schema, and the API checks everything again. The new member's page
 * then says whether the email went.
 */
export function InviteMemberForm({
  roles,
  locations,
}: {
  readonly roles: readonly AssignableRole[];
  readonly locations: readonly { readonly id: string; readonly name: string }[];
}) {
  const router = useRouter();
  const entry = useEntryId();
  const ids = useFieldIds(FIELDS);
  const [roleId, setRoleId] = useState("");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const places = roles.find((r) => r.id === roleId)?.locationIds ?? [];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readInvite(new FormData(event.currentTarget), entry.id, roles, t);
    if (!read.ok) {
      setResult(fieldErrors(read.fields));
      return;
    }
    startTransition(async () => {
      const outcome = await addAndInvite(read.value);
      setResult(outcome);
      if (outcome.ok) {
        entry.next();
        const done = outcome.data.emailSent ? "sent" : "emailFailed";
        router.push(`/settings/team/${outcome.data.memberId}?done=${done}&at=${Date.now()}`);
      }
    });
  };

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.displayName}
        name="displayName"
        label={t("team.invite.name")}
        autoComplete="off"
        maxLength={200}
        error={errorFor(result, "displayName")}
      />
      <TextField
        id={ids.email}
        name="email"
        type="email"
        label={t("team.invite.email")}
        hint={t("team.invite.emailHint")}
        autoComplete="off"
        spellCheck={false}
        maxLength={254}
        error={errorFor(result, "email")}
      />
      <SelectField
        id={ids.roleId}
        name="roleId"
        label={t("team.invite.role")}
        emptyOption={t("team.invite.roleEmpty")}
        value={roleId}
        onChange={(event) => setRoleId(event.target.value)}
        options={roles.map((r) => ({ value: r.id, label: r.name }))}
        error={errorFor(result, "roleId")}
      />
      <SelectField
        id={ids.locationId}
        name="place"
        label={t("team.invite.place")}
        hint={roleId ? undefined : t("team.invite.placeHint")}
        emptyOption={t("team.invite.placeEmpty")}
        options={places.map((place) => ({
          value: place ?? ORGANISATION,
          label: place
            ? (locations.find((l) => l.id === place)?.name ?? t("team.place.another"))
            : t("team.invite.organisation"),
        }))}
        error={errorFor(result, "locationId")}
      />
      <div>
        <Button
          type="submit"
          disabled={pending}
          icon={<Send size={18} strokeWidth={1.5} aria-hidden="true" />}
        >
          {pending ? t("common.saving") : t("team.invite.submit")}
        </Button>
      </div>
      <ManageFeedback
        result={result}
        path="/settings/team"
        fieldIds={ids}
        stepUp={t("team.stepUp.form")}
      />
    </form>
  );
}
