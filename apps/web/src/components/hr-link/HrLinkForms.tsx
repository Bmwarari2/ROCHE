"use client";

import type { HrDataKind, HrOwners } from "@harbour/domain";
import {
  Button,
  Checkbox,
  DateInput,
  RadioGroup,
  SelectField,
  Sheet,
  SheetClose,
  TextField,
} from "@harbour/ui";
import {
  CircleAlert,
  CircleCheck,
  Link2,
  RefreshCw,
  Save,
  ShieldCheck,
  Undo2,
  Unlink,
  UserCheck,
  UserX,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import {
  changeHrLinkSettings,
  changePayCodes,
  changePayRoute,
  confirmHrMatch,
  connectHrLink,
  disconnectHrLink,
  mapHrLocation,
  rejectHrMatch,
  releaseHrCopies,
  syncHrLink,
  testHrLink,
} from "@/app/actions/hr-link";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import {
  CHOOSABLE_KINDS,
  HR_LINK_PAGE,
  PAY_UNIT_KINDS,
  payCodeField,
  RELEASE_REASONS,
  type ReleaseMode,
  readConnect,
  readLocationMap,
  readPayCodes,
  readPayRoute,
  readRelease,
  readSettings,
  STALENESS_MAX_MINUTES,
  STALENESS_MIN_MINUTES,
  unitKindWords,
} from "@/lib/hr-link";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors, partsFor } from "@/lib/outcome";
import { dateBoxesOf } from "@/lib/uk-time";

/**
 * The link to the HR platform's forms (integrations.md section 11; slice 90; HZ-133, HZ-140).
 * Each sends through a server action; on success the page opens again and says what was done
 * (RecordedArrival); a refusal is said at its field and in the summary, and a step-up refusal
 * sends the person to confirm it is them and back here.
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

type Done = Record<string, string>;

function useHrLinkSend() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = <T,>(
    call: () => Promise<ActionResult<T>>,
    arrival: (data: T) => Done,
    after?: () => void,
  ) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        after?.();
        const params = new URLSearchParams({ ...arrival(outcome.data), at: String(Date.now()) });
        router.replace(`${HR_LINK_PAGE}?${params.toString()}`, { scroll: false });
        router.refresh();
      }
    });
  return { result, pending, send, setResult };
}

const feedback = (result: ActionResult<unknown> | null, fieldIds?: Record<string, string>) => (
  <ManageFeedback
    result={result}
    path={HR_LINK_PAGE}
    stepUp={t("hrLink.stepUp")}
    {...(fieldIds ? { fieldIds } : {})}
  />
);

const appName = () => t("app.name");

/** Connects the organisation's workspace in the HR platform (UK only; the API checks it). */
export function ConnectForm() {
  const ids = useFieldIds(["workspaceSlug", "secretRef"]);
  const { result, pending, send, setResult } = useHrLinkSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readConnect(new FormData(event.currentTarget), t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => connectHrLink(read.body),
      () => ({ done: "connected" }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.workspaceSlug}
        name="workspaceSlug"
        label={t("hrLink.connect.slug")}
        hint={t("hrLink.connect.slugHint")}
        autoComplete="off"
        spellCheck={false}
        required
        maxLength={63}
        error={errorFor(result, "workspaceSlug")}
      />
      <TextField
        id={ids.secretRef}
        name="secretRef"
        label={t("hrLink.connect.secret")}
        hint={t("hrLink.connect.secretHint")}
        autoComplete="off"
        spellCheck={false}
        error={errorFor(result, "secretRef")}
      />
      <div>
        <Button type="submit" icon={<Link2 {...icon} />} disabled={pending}>
          {pending ? t("hrLink.connect.pending") : t("hrLink.connect.submit")}
        </Button>
      </div>
      {feedback(result, ids)}
    </form>
  );
}

type Checked =
  | { readonly kind: "test"; readonly ok: boolean; readonly code: string | null }
  | {
      readonly kind: "sync";
      readonly linked: number;
      readonly review: number;
      readonly failed: number;
      readonly error: string | null;
    };

/**
 * Checks the link now, or pulls and reconciles now. Each says what happened in a polite status,
 * with an icon and words; the page's status and sync health then show the new state.
 */
export function CheckButtons() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (which: "test" | "sync") =>
    startTransition(async () => {
      setChecked(null);
      if (which === "test") {
        const outcome = await testHrLink();
        setResult(outcome);
        if (outcome.ok && outcome.data) {
          setChecked({ kind: "test", ok: outcome.data.ok, code: outcome.data.code });
        }
      } else {
        const outcome = await syncHrLink();
        setResult(outcome);
        if (outcome.ok && outcome.data) {
          const d = outcome.data;
          setChecked({
            kind: "sync",
            linked: d.linked,
            review: d.review,
            failed: d.failed + (d.absences?.failed ?? 0) + (d.deliveries?.failed ?? 0),
            error: d.error ?? d.absences?.error ?? d.deliveries?.error ?? null,
          });
        }
      }
      router.refresh();
    });
  const good = checked && (checked.kind === "test" ? checked.ok : checked.error === null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          icon={<ShieldCheck {...icon} />}
          disabled={pending}
          onClick={() => run("test")}
        >
          {t("hrLink.check.test")}
        </Button>
        <Button
          variant="secondary"
          icon={<RefreshCw {...icon} />}
          disabled={pending}
          onClick={() => run("sync")}
        >
          {t("hrLink.check.sync")}
        </Button>
      </div>
      <div role="status">
        {pending ? <p className="m-0">{t("hrLink.check.pending")}</p> : null}
        {!pending && checked ? (
          <p className="m-0 inline-flex items-start gap-2 font-semibold">
            {good ? (
              <CircleCheck {...icon} className="mt-0.5 shrink-0" />
            ) : (
              <CircleAlert {...icon} className="mt-0.5 shrink-0" />
            )}
            <span>
              {checked.kind === "test"
                ? checked.ok
                  ? t("hrLink.check.testOk")
                  : t("hrLink.check.testFailed", {
                      reason: t("hrLink.code", { code: checked.code ?? "unavailable" }),
                    })
                : t("hrLink.check.synced", {
                    linked: checked.linked,
                    review: checked.review,
                    failed: checked.failed,
                    error: checked.error ? "yes" : "no",
                    reason: checked.error ? t("hrLink.code", { code: checked.error }) : "",
                  })}
            </span>
          </p>
        ) : null}
      </div>
      {feedback(result)}
    </div>
  );
}

/** Who owns each kind of staff data, and how old the copy may be before screens say so. */
export function SettingsForm({
  version,
  owners,
  stalenessMinutes,
}: {
  readonly version: number;
  readonly owners: HrOwners;
  readonly stalenessMinutes: number;
}) {
  const keys = [...CHOOSABLE_KINDS.map((k) => `owner-${k}`), "stalenessMinutes"];
  const ids = useFieldIds(keys);
  const [chosen, setChosen] = useState<Record<string, "harbour" | "thapsus_hr">>(() =>
    Object.fromEntries(CHOOSABLE_KINDS.map((k) => [k, owners[k]])),
  );
  const { result, pending, send, setResult } = useHrLinkSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readSettings(new FormData(event.currentTarget), t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () =>
        changeHrLinkSettings({
          expectedVersion: version,
          owners: read.owners,
          stalenessMinutes: read.stalenessMinutes,
        }),
      () => ({ done: "settings" }),
    );
  };
  const ownerOptions = [
    {
      value: "thapsus_hr" as const,
      label: t("hrLink.owners.system", { system: "thapsus_hr", app: appName() }),
    },
    {
      value: "harbour" as const,
      label: t("hrLink.owners.system", { system: "harbour", app: appName() }),
    },
  ];
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {CHOOSABLE_KINDS.map((kind: HrDataKind) => (
        <RadioGroup<"harbour" | "thapsus_hr">
          key={kind}
          id={ids[`owner-${kind}`]}
          name={`owner-${kind}`}
          legend={t("hrLink.owners.kind", { kind })}
          layout="inline"
          value={chosen[kind] ?? null}
          onValueChange={(value) => setChosen((now) => ({ ...now, [kind]: value }))}
          options={ownerOptions}
          error={errorFor(result, `owner-${kind}`)}
        />
      ))}
      <TextField
        id={ids.stalenessMinutes}
        name="stalenessMinutes"
        label={t("hrLink.owners.staleness")}
        hint={t("hrLink.owners.stalenessHint", {
          min: STALENESS_MIN_MINUTES,
          max: STALENESS_MAX_MINUTES,
        })}
        inputMode="numeric"
        autoComplete="off"
        defaultValue={String(stalenessMinutes)}
        className="max-w-[8rem]"
        error={errorFor(result, "stalenessMinutes")}
      />
      <div>
        <Button type="submit" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("hrLink.owners.submit")}
        </Button>
      </div>
      {feedback(result, ids)}
    </form>
  );
}

/** Stops the link after a confirmation that says what stays and what stops. */
export function DisconnectForm() {
  const [open, setOpen] = useState(false);
  const { result, pending, send } = useHrLinkSend();
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="destructive" icon={<Unlink {...icon} />}>
          {t("hrLink.disconnect.open")}
        </Button>
      }
      title={t("hrLink.disconnect.title")}
      closeLabel={t("common.close")}
    >
      <div className="flex flex-col gap-4">
        <p className="m-0">{t("hrLink.disconnect.body", { app: appName() })}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("hrLink.disconnect.keep")}</Button>
          </SheetClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              send(
                () => disconnectHrLink(),
                () => ({ done: "disconnected" }),
                () => setOpen(false),
              )
            }
          >
            {pending ? t("common.saving") : t("hrLink.disconnect.confirm")}
          </Button>
        </div>
        {feedback(result)}
      </div>
    </Sheet>
  );
}

/** Maps one home to a location in the HR platform, or clears its mapping. */
export function LocationMapForm({
  locationId,
  name,
  current,
  options,
}: {
  readonly locationId: string;
  readonly name: string;
  readonly current: string | null;
  readonly options: readonly { readonly id: string; readonly name: string }[];
}) {
  const ids = useFieldIds(["hrLocationId"]);
  const { result, pending, send, setResult } = useHrLinkSend();
  const offered = new Set(options.map((o) => o.id));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readLocationMap(new FormData(event.currentTarget), offered, t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => mapHrLocation({ locationId, hrLocationId: read.hrLocationId }),
      () => ({ done: "located" }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <SelectField
        id={ids.hrLocationId}
        name="hrLocationId"
        label={t("hrLink.locations.select", { name })}
        emptyOption={t("hrLink.locations.notMapped")}
        defaultValue={current ?? ""}
        options={options.map((o) => ({ value: o.id, label: o.name }))}
        error={errorFor(result, "hrLocationId")}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("hrLink.locations.submit", { name })}
        </Button>
      </div>
      {feedback(result, ids)}
    </form>
  );
}

/**
 * Confirms a match to a staff file (a fresh step-up; never the reviewer's own file) or rejects
 * it, so the employee is neither rostered from the HR platform's data nor sent to it.
 */
export function MatchReviewForm({
  id,
  version,
  who,
  staff,
  suggested,
}: {
  readonly id: string;
  readonly version: number;
  /** The employee in words, for the buttons' accessible names. */
  readonly who: string;
  readonly staff: readonly { readonly id: string; readonly label: string }[];
  readonly suggested: string | null;
}) {
  const ids = useFieldIds(["staffProfileId"]);
  const { result, pending, send, setResult } = useHrLinkSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("staffProfileId");
    const chosen = typeof value === "string" ? value : "";
    if (!staff.some((s) => s.id === chosen)) {
      return setResult(fieldErrors({ staffProfileId: t("hrLink.matches.chooseError") }));
    }
    send(
      () => confirmHrMatch({ id, version, staffProfileId: chosen }),
      () => ({ done: "confirmed" }),
    );
  };
  const reject = () =>
    send(
      () => rejectHrMatch({ id, version }),
      () => ({ done: "rejected" }),
    );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <SelectField
        id={ids.staffProfileId}
        name="staffProfileId"
        label={t("hrLink.matches.staffFile")}
        hint={t("hrLink.matches.staffFileHint")}
        emptyOption={t("hrLink.matches.choose")}
        defaultValue={suggested ?? ""}
        options={staff.map((s) => ({ value: s.id, label: s.label }))}
        error={errorFor(result, "staffProfileId")}
      />
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          icon={<UserCheck {...icon} />}
          disabled={pending}
          aria-label={t("hrLink.matches.confirmFor", { who })}
        >
          {t("hrLink.matches.confirm")}
        </Button>
        <Button
          variant="secondary"
          icon={<UserX {...icon} />}
          disabled={pending}
          onClick={reject}
          aria-label={t("hrLink.matches.rejectFor", { who })}
        >
          {t("hrLink.matches.reject")}
        </Button>
      </div>
      {feedback(result, ids)}
    </form>
  );
}

/** Moves the route to payroll from the first day of a later pay period (a fresh step-up). */
export function PayRouteForm({
  version,
  current,
}: {
  readonly version: number;
  readonly current: "harbour_export" | "thapsus_hr";
}) {
  const ids = useFieldIds(["route", "from"]);
  const [route, setRoute] = useState<"harbour_export" | "thapsus_hr">(
    current === "thapsus_hr" ? "harbour_export" : "thapsus_hr",
  );
  const { result, pending, send, setResult } = useHrLinkSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readPayRoute(new FormData(event.currentTarget), t);
    if (!read.ok) {
      return setResult({
        ...fieldErrors(read.errors),
        ...(read.parts ? { parts: read.parts } : {}),
      });
    }
    send(
      () => changePayRoute({ expectedVersion: version, route: read.route, from: read.from }),
      () => ({ done: "payRoute" }),
    );
  };
  const fromError = errorFor(result, "from");
  const fromParts = dateBoxesOf(partsFor(result, "from"));
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup<"harbour_export" | "thapsus_hr">
        id={ids.route}
        name="route"
        legend={t("hrLink.pay.routeLegend")}
        value={route}
        onValueChange={setRoute}
        options={[
          {
            value: "thapsus_hr",
            label: t("hrLink.pay.route", { route: "thapsus_hr", app: appName() }),
          },
          {
            value: "harbour_export",
            label: t("hrLink.pay.route", { route: "harbour_export", app: appName() }),
          },
        ]}
        error={errorFor(result, "route")}
      />
      <DateInput
        id={ids.from}
        name="from"
        legend={t("hrLink.pay.from")}
        hint={t("hrLink.pay.fromHint")}
        labels={{
          day: t("care.date.day"),
          month: t("care.date.month"),
          year: t("care.date.year"),
        }}
        {...(fromError ? { error: fromError } : {})}
        {...(fromParts ? { errorParts: fromParts } : {})}
      />
      <div>
        <Button type="submit" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("hrLink.pay.routeSubmit")}
        </Button>
      </div>
      {feedback(result, ids)}
    </form>
  );
}

/** The pay code in the HR platform for each unit kind; a blank kind is not mapped. */
export function PayCodesForm({
  version,
  codes,
}: {
  readonly version: number;
  readonly codes: Readonly<Record<string, string>>;
}) {
  const ids = useFieldIds(PAY_UNIT_KINDS.map(payCodeField));
  const { result, pending, send, setResult } = useHrLinkSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readPayCodes(new FormData(event.currentTarget), t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => changePayCodes({ expectedVersion: version, codes: read.codes }),
      () => ({ done: "payCodes" }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">{t("hrLink.pay.codesLegend")}</legend>
        {PAY_UNIT_KINDS.map((kind) => (
          <TextField
            key={kind}
            id={ids[payCodeField(kind)]}
            name={payCodeField(kind)}
            label={unitKindWords(kind, t)}
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            defaultValue={codes[kind] ?? ""}
            error={errorFor(result, payCodeField(kind))}
          />
        ))}
      </fieldset>
      <div>
        <Button type="submit" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("hrLink.pay.codesSubmit")}
        </Button>
      </div>
      {feedback(result, ids)}
    </form>
  );
}

/**
 * Releases the absence copies the drift guard held (or, once disconnected, the copies still in
 * force), after a coded reason and a box that says they were checked. The ids shown are the ones
 * sent: if the HR platform's list has changed since, nothing is released and the page says so.
 */
export function ReleaseForm({
  mode,
  hrIds,
  children,
}: {
  readonly mode: ReleaseMode;
  readonly hrIds: readonly string[];
  /** The copies, as the page lists them. */
  readonly children: ReactNode;
}) {
  const ids = useFieldIds(["reason", "checked"]);
  const [reason, setReason] = useState<string | null>(null);
  const { result, pending, send, setResult } = useHrLinkSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readRelease(new FormData(event.currentTarget), mode, t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => releaseHrCopies({ expectedHrIds: hrIds, reason: read.reason }),
      (data) => ({ done: "released", count: String(data?.released ?? 0) }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {children}
      <RadioGroup<string>
        id={ids.reason}
        name="reason"
        legend={t("hrLink.release.reasonLegend")}
        value={reason}
        onValueChange={setReason}
        options={RELEASE_REASONS[mode].map((r) => ({
          value: r,
          label: t("hrLink.release.reason", { reason: r }),
        }))}
        error={errorFor(result, "reason")}
      />
      <Checkbox
        id={ids.checked}
        name="checked"
        value="yes"
        required
        label={t("hrLink.release.checked", { count: hrIds.length })}
        error={errorFor(result, "checked")}
      />
      <div>
        <Button type="submit" icon={<Undo2 {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("hrLink.release.submit", { count: hrIds.length })}
        </Button>
      </div>
      {feedback(result, ids)}
    </form>
  );
}
