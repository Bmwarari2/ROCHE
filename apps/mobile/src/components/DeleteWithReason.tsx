import { Button, Text, useTheme } from "@harbour/ui-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import {
  checkDiscardReason,
  DISCARD_REASON_LIMITS,
  type DiscardReason,
} from "../app-state/held-work";
import { DISCARD_REASON_CODES, type DiscardReasonCode } from "../app-state/tombstones";
import type { FieldError } from "../care/entries";
import { t } from "../i18n/t";
import { ChoiceGroup, errorText } from "./forms";
import { TextField } from "./TextField";

export const EMPTY_REASON: DiscardReason = { reasonCode: null, reason: "" };

/** The coded reasons, in the catalogue's words. */
export function reasonOptions() {
  return DISCARD_REASON_CODES.map((code: DiscardReasonCode) => ({
    value: code,
    label: t(`mobile.discard.code.${code}`),
  }));
}

/**
 * Why entries that never reached the server are deleted (security review M1): a coded reason from
 * a fixed list, which is all the device keeps, and the person's own words, needed for "Other". The
 * words go to Harbour with the deletion and are never kept on the device.
 */
export function DiscardReasonFields({
  label,
  value,
  onChange,
  error,
  testID,
}: {
  readonly label: string;
  readonly value: DiscardReason;
  readonly onChange: (next: DiscardReason) => void;
  readonly error: FieldError | null;
  readonly testID: string;
}) {
  const theme = useTheme();
  const wordsError = error && error.key !== "mobile.discard.reasonCodeRequired" ? error : null;
  return (
    <View style={{ gap: theme.space[1] }}>
      <ChoiceGroup
        label={label}
        options={reasonOptions()}
        value={value.reasonCode}
        onChange={(reasonCode) => onChange({ ...value, reasonCode })}
        error={error?.key === "mobile.discard.reasonCodeRequired" ? error : null}
        testID={`${testID}-code`}
      />
      <TextField
        label={t("mobile.discard.wordsLabel")}
        hint={t("mobile.discard.wordsHint")}
        value={value.reason}
        onChangeText={(reason) => onChange({ ...value, reason })}
        multiline
        maxLength={DISCARD_REASON_LIMITS.max}
        errorText={errorText(wordsError)}
        testID={`${testID}-reason`}
      />
    </View>
  );
}

interface DeleteWithReasonProps {
  /** Names what is deleted, with the count: "Sign out and delete 3 unsent entries". */
  readonly buttonLabel: string;
  /** The confirmation's title names the count too: "Delete 3 unsent entries?". */
  readonly confirmTitle: string;
  readonly confirmBody: string;
  readonly confirmLabel?: string;
  readonly reasonLabel: string;
  /** Does the deletion; the vault asks for device authentication first (S4). */
  readonly onConfirm: (choice: DiscardReason) => Promise<void>;
  /** Opens with the reason showing (the caller already asked to delete). */
  readonly initiallyOpen?: boolean;
  readonly onCancel?: () => void;
  readonly testID: string;
}

/**
 * Deleting entries that never reached the server (security review S4 and M1, clinical review C2):
 * the button names the count, a coded reason is required, a confirmation names the count again,
 * and the vault asks for device authentication and puts the deletion on record before anything is
 * deleted.
 */
export function DeleteWithReason({
  buttonLabel,
  confirmTitle,
  confirmBody,
  confirmLabel,
  reasonLabel,
  onConfirm,
  initiallyOpen = false,
  onCancel,
  testID,
}: DeleteWithReasonProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(initiallyOpen);
  const [choice, setChoice] = useState<DiscardReason>(EMPTY_REASON);
  const [problem, setProblem] = useState<FieldError | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button
        label={buttonLabel}
        variant="destructive"
        onPress={() => setOpen(true)}
        fullWidth
        testID={testID}
      />
    );
  }

  const proceed = () => {
    if (busy) return;
    const found = checkDiscardReason(choice);
    setProblem(found);
    setFailure(null);
    if (found) return;
    Alert.alert(confirmTitle, confirmBody, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: confirmLabel ?? t("mobile.held.discardConfirm"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          onConfirm({ reasonCode: choice.reasonCode, reason: choice.reason.trim() })
            .catch((caught: unknown) =>
              setFailure(
                caught instanceof Error ? caught.message : t("mobile.held.discardIncomplete"),
              ),
            )
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <View style={{ gap: theme.space[1] }} testID={`${testID}-form`}>
      <DiscardReasonFields
        label={reasonLabel}
        value={choice}
        onChange={setChoice}
        error={problem}
        testID={testID}
      />
      {failure ? (
        <Text
          variant="bodyDense"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          testID={`${testID}-failure`}
        >
          {failure}
        </Text>
      ) : null}
      <Button
        label={buttonLabel}
        variant="destructive"
        onPress={proceed}
        loading={busy}
        fullWidth
        testID={`${testID}-confirm`}
      />
      <Button
        label={t("common.cancel")}
        variant="secondary"
        onPress={() => {
          setOpen(false);
          setChoice(EMPTY_REASON);
          setProblem(null);
          setFailure(null);
          onCancel?.();
        }}
        fullWidth
        testID={`${testID}-cancel`}
      />
    </View>
  );
}
