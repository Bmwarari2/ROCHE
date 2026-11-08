import type { IncidentType } from "@harbour/contracts";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import type { FieldError } from "../../../../care/entries";
import { useEntryContext, useWhenChoice } from "../../../../care/hooks";
import {
  ANSWERS,
  type Answer,
  checkIncident,
  INCIDENT_TEXT_LIMITS,
  INCIDENT_TYPES,
  type IncidentField,
} from "../../../../care/incidents";
import { useSaveAndReturn } from "../../../../care/use-save";
import { FormScreen } from "../../../../components/FormScreen";
import { ChoiceGroup, errorText, WhenField } from "../../../../components/forms";
import { StatusLine } from "../../../../components/StatusLine";
import { TextField } from "../../../../components/TextField";
import { t } from "../../../../i18n/t";
import { useRecordScreenProtection } from "../../../../security/use-record-protection";

/**
 * Report an incident about this person, offline (MOB-006). It is queued on the phone and sent when
 * there is a connection; the form says that nobody is alerted until then (HZ-006).
 */
export default function IncidentScreen() {
  useRecordScreenProtection("incident");
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const id = typeof personId === "string" ? personId : "";
  const context = useEntryContext(id);
  const { report, saving, saveFailed } = useSaveAndReturn(id);

  const [type, setType] = useState<IncidentType | null>(null);
  const [when, setWhen] = useWhenChoice(undefined);
  const [description, setDescription] = useState("");
  const [immediateActions, setImmediateActions] = useState("");
  const [emergencyServices, setEmergencyServices] = useState<Answer | null>(null);
  const [gp, setGp] = useState<Answer | null>(null);
  const [errors, setErrors] = useState<Partial<Record<IncidentField, FieldError>>>({});

  const save = () => {
    const result = checkIncident(
      { type, when, description, immediateActions, emergencyServices, gp },
      context,
      new Date(),
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    void report(result.row);
  };

  const answers = ANSWERS.map((value) => ({
    value,
    label: t("mobile.incident.answer", { answer: value }),
  }));

  return (
    <FormScreen
      personId={id}
      title={t("mobile.incident.title")}
      testID="incident-screen"
      showErrors={Object.keys(errors).length > 0}
      saveFailed={saveFailed}
      saving={saving}
      onSave={save}
    >
      <StatusLine tone="warning" testID="incident-not-alerted">
        {t("mobile.incident.notAlerted")}
      </StatusLine>
      {errors.location ? (
        <StatusLine tone="danger" testID="incident-no-location">
          {errorText(errors.location) ?? ""}
        </StatusLine>
      ) : null}
      <ChoiceGroup
        label={t("mobile.incident.type")}
        testID="incident-type"
        value={type}
        onChange={setType}
        options={INCIDENT_TYPES.map((value) => ({
          value,
          label: t("mobile.incident.typeName", { type: value }),
        }))}
        error={errors.type}
      />
      <WhenField
        value={when}
        onChange={setWhen}
        error={errors.when}
        windowDays={context.windowDays ?? null}
        toleranceMinutes={context.clockToleranceMinutes ?? 0}
        original={null}
      />
      <TextField
        label={t("mobile.incident.description")}
        hint={t("mobile.incident.descriptionHint")}
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={INCIDENT_TEXT_LIMITS.max}
        textAlignVertical="top"
        minHeight={120}
        errorText={errorText(errors.description)}
        testID="incident-description"
      />
      <TextField
        label={t("mobile.incident.immediateActions")}
        hint={t("mobile.incident.immediateActionsHint")}
        value={immediateActions}
        onChangeText={setImmediateActions}
        multiline
        maxLength={INCIDENT_TEXT_LIMITS.max}
        textAlignVertical="top"
        minHeight={96}
        errorText={errorText(errors.immediateActions)}
        testID="incident-actions"
      />
      <ChoiceGroup
        label={t("mobile.incident.emergencyServices")}
        testID="incident-emergency"
        value={emergencyServices}
        onChange={setEmergencyServices}
        options={answers}
        error={errors.emergencyServices}
      />
      <ChoiceGroup
        label={t("mobile.incident.gp")}
        testID="incident-gp"
        value={gp}
        onChange={setGp}
        options={answers}
        error={errors.gp}
      />
    </FormScreen>
  );
}
