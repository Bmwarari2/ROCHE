"use client";

import { Button, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { Search } from "lucide-react";
import { type KeyboardEvent, useState, useTransition } from "react";
import { findWitness, type WitnessOption } from "@/app/actions/property";
import type { Signer } from "@/lib/admission";
import { characterCount, t } from "@/lib/i18n";

/**
 * Fields shared by the property forms (people.md rule 7): who signed for an item, or why nobody
 * could, and the second member of staff who witnessed it.
 */

/** Who signed: the person or their representative by typed name, or why nobody could sign. */
export function SignatureFields({
  ids,
  errors,
  legend,
  signer,
  onSignerChange,
}: {
  readonly ids: { readonly signer: string; readonly name: string; readonly unableReason: string };
  readonly errors: {
    readonly signer?: string | undefined;
    readonly name?: string | undefined;
    readonly unableReason?: string | undefined;
  };
  readonly legend: string;
  readonly signer: Signer | null;
  readonly onSignerChange: (signer: Signer) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup<Signer>
        id={ids.signer}
        name="signer"
        legend={legend}
        layout="stack"
        value={signer}
        onValueChange={onSignerChange}
        required
        error={errors.signer}
        options={(["person", "representative", "unable_to_sign"] as const).map((value) => ({
          value,
          label: t("people.property.signer", { signer: value }),
        }))}
      />
      {signer === "person" || signer === "representative" ? (
        <TextField
          id={ids.name}
          name="signerName"
          label={t("people.property.form.signerName", { signer })}
          hint={t("people.property.form.signerNameHint")}
          autoComplete="off"
          maxLength={200}
          required
          error={errors.name}
          className="max-w-md"
        />
      ) : null}
      {signer === "unable_to_sign" ? (
        <TextArea
          id={ids.unableReason}
          name="unableReason"
          label={t("people.property.form.unableReason")}
          rows={2}
          required
          maxLength={500}
          formatCount={(remaining) => characterCount(remaining)}
          error={errors.unableReason}
        />
      ) : null}
    </div>
  );
}

/**
 * The witness: a colleague found by name (the staff search, in the scope the user may find
 * colleagues in), never the person recording. An attestation, not a sign-in: the record names
 * both. The chosen colleague is sent as `witness`.
 */
export function WitnessPicker({
  id,
  error,
  reason,
}: {
  /** The search box's id, for the error summary's link. */
  readonly id: string;
  readonly error?: string | undefined;
  /** Why a witness is needed here, in words. */
  readonly reason: string;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<readonly WitnessOption[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const find = () =>
    startTransition(async () => {
      const outcome = await findWitness(query);
      setChosen(null);
      if (outcome.ok) {
        setOptions(outcome.data);
        setProblem(null);
      } else {
        setOptions(null);
        setProblem(outcome.message);
      }
    });
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter finds a colleague; it never sends the item's form from the search box.
    if (event.key === "Enter") {
      event.preventDefault();
      find();
    }
  };
  const errorId = `${id}-witness-error`;
  return (
    <fieldset
      className="m-0 flex flex-col gap-3 rounded-input border border-border p-4"
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="px-1 font-semibold">{t("people.property.witness.legend")}</legend>
      <p className="m-0">{reason}</p>
      {error ? (
        <p id={errorId} className="hb-field__error m-0">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          id={id}
          label={t("people.property.witness.query")}
          hint={t("people.property.witness.queryHint")}
          value={query}
          maxLength={100}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 max-w-md flex-1"
        />
        <Button
          variant="secondary"
          icon={<Search size={16} strokeWidth={1.5} />}
          disabled={pending}
          onClick={find}
        >
          {t("people.property.witness.find")}
        </Button>
      </div>
      <div role="status" className="m-0">
        {problem ? <p className="m-0">{problem}</p> : null}
        {options && options.length === 0 ? (
          <p className="m-0">{t("people.property.witness.none")}</p>
        ) : null}
      </div>
      {options && options.length > 0 ? (
        <RadioGroup<string>
          name="witness"
          legend={t("people.property.witness.choose")}
          value={chosen}
          onValueChange={setChosen}
          options={options.map((option) => ({
            value: option.id,
            label: option.name,
            ...(option.roles.length > 0 ? { description: option.roles.join(", ") } : {}),
          }))}
        />
      ) : null}
    </fieldset>
  );
}
