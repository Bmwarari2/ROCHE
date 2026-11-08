import { type AdministrationOutcome, OUTCOME_REASONS } from "@harbour/domain";
import { Button, Text, useTheme } from "@harbour/ui-native";
import { usePowerSync } from "@powersync/react";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, findNodeHandle, View } from "react-native";
import { useSession } from "../app-state/session";
import { useTenantId } from "../care/hooks";
import { t } from "../i18n/t";
import {
  type CorrectionInput,
  type CorrectionProblem,
  correctionProblems,
  localCorrectionRow,
} from "../medicines/correction";
import { PHONE_OUTCOMES } from "../medicines/record";
import { newEntryId } from "../platform/ids";
import { StatusLine } from "./StatusLine";
import { TextField } from "./TextField";

/**
 * Correcting a record on the phone (slice 70; HZ-004): what really happened, with why. The record
 * stays, struck through on the MAR; the correction names it and goes to Harbour when there is a
 * connection, where every rule is checked again.
 */
export function CorrectionPanel({
  personId,
  personName,
  productName,
  original,
  unitName,
  controlledDrug,
  onDone,
}: {
  readonly personId: string;
  readonly personName: string;
  readonly productName: string;
  readonly original: CorrectionInput["original"];
  readonly unitName: string | null;
  readonly controlledDrug: boolean;
  readonly onDone: (saved: boolean) => void;
}) {
  const theme = useTheme();
  const db = usePowerSync();
  const tenantId = useTenantId();
  const { me } = useSession();
  const [outcome, setOutcome] = useState<AdministrationOutcome | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState(original.quantity ?? "");
  const [why, setWhy] = useState("");
  const [problems, setProblems] = useState<readonly CorrectionProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const titleRef = useRef<View>(null);
  // Focus moves to the panel's title when it opens (WCAG 2.4.3).
  useEffect(() => {
    const node = titleRef.current ? findNodeHandle(titleRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, []);

  const save = async () => {
    if (!outcome || saving) return;
    const quantity = Number(amount);
    const input: CorrectionInput = {
      id: newEntryId(),
      tenantId,
      personId,
      memberId: me?.tenantUserId ?? "",
      original,
      outcome,
      reason: reasonCode ? { code: reasonCode, note: note.trim() || null } : null,
      amount:
        outcome === "given" && amount.trim() && Number.isFinite(quantity) && original.unitCode
          ? { quantity, unitCode: original.unitCode }
          : null,
      correctionReason: why,
      controlledDrug,
      at: new Date(),
    };
    const found = correctionProblems(input);
    setProblems(found);
    if (found.length > 0) {
      AccessibilityInfo.announceForAccessibility(
        found.map((p) => t("mobile.meds.correctionProblem", { problem: p })).join(" "),
      );
      return;
    }
    setSaving(true);
    try {
      const row = localCorrectionRow(input);
      const columns = Object.keys(row);
      await db.execute(
        `INSERT INTO medication_administration (${columns.join(", ")}) VALUES (${columns
          .map(() => "?")
          .join(", ")})`,
        columns.map((c) => row[c] ?? null),
      );
      AccessibilityInfo.announceForAccessibility(t("mobile.meds.correctionSaved"));
      onDone(true);
    } catch {
      setFailed(true);
      AccessibilityInfo.announceForAccessibility(t("mobile.meds.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const reasons = outcome ? OUTCOME_REASONS[outcome] : [];
  return (
    <View style={{ gap: theme.space[1.5] }} testID="correction-panel">
      <View ref={titleRef} accessible accessibilityRole="header">
        <Text variant="title">
          {t("mobile.meds.correctionTitle", { medicine: productName, person: personName })}
        </Text>
      </View>
      <Text>
        {t("mobile.meds.correctionWas", {
          outcome: original.outcome,
          amount: original.quantity ?? "none",
          unit: unitName ?? "",
        })}
      </Text>
      <Text variant="callout" accessibilityRole="header">
        {t("mobile.meds.correctionWhatHappened")}
      </Text>
      <View accessibilityRole="radiogroup" style={{ gap: theme.space[1] }}>
        {PHONE_OUTCOMES.map((o) => (
          <Button
            key={o}
            label={t("mobile.meds.outcomeName", { outcome: o })}
            selection={{ kind: "radio", selected: outcome === o }}
            onPress={() => {
              setOutcome(o);
              setReasonCode(null);
            }}
          />
        ))}
      </View>
      {reasons.length > 0 ? (
        <View accessibilityRole="radiogroup" style={{ gap: theme.space[1] }}>
          {reasons.map((code) => (
            <Button
              key={code}
              label={t("mobile.meds.reasonName", { reason: code })}
              selection={{ kind: "radio", selected: reasonCode === code }}
              onPress={() => setReasonCode(code)}
            />
          ))}
          <TextField
            label={t("mobile.meds.note")}
            value={note}
            onChangeText={setNote}
            maxLength={2000}
          />
        </View>
      ) : null}
      {outcome === "given" ? (
        <TextField
          label={t("mobile.meds.amount", { unit: unitName ?? "none" })}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
        />
      ) : null}
      <TextField
        label={t("mobile.meds.correctionWhy")}
        hint={t("mobile.meds.correctionWhyHint")}
        value={why}
        onChangeText={setWhy}
        maxLength={2000}
        multiline
        testID="correction-why"
      />
      {problems.map((p) => (
        <StatusLine key={p} tone="danger">
          {t("mobile.meds.correctionProblem", { problem: p })}
        </StatusLine>
      ))}
      {failed ? <StatusLine tone="danger">{t("mobile.meds.saveFailed")}</StatusLine> : null}
      <Button
        label={t("mobile.meds.correctionSave")}
        onPress={() => void save()}
        disabled={!outcome}
        loading={saving}
        testID="save-correction"
      />
      <Button
        label={t("mobile.meds.stop")}
        accessibilityHint={t("mobile.meds.stopHint")}
        variant="secondary"
        onPress={() => onDone(false)}
      />
    </View>
  );
}
