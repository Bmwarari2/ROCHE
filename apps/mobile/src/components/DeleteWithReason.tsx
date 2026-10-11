import { Button, useTheme } from "@harbour/ui-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import { checkDiscardReason, DISCARD_REASON_LIMITS } from "../app-state/held-work";
import { t } from "../i18n/t";
import { TextField } from "./TextField";

interface DeleteWithReasonProps {
  /** Names what is deleted, with the count: "Sign out and delete 3 unsent entries". */
  readonly buttonLabel: string;
  /** The confirmation's title names the count too: "Delete 3 unsent entries?". */
  readonly confirmTitle: string;
  readonly confirmBody: string;
  readonly confirmLabel?: string;
  readonly reasonLabel: string;
  /** Does the deletion; the vault asks for device authentication first (S4). */
  readonly onConfirm: (reason: string) => Promise<void>;
  /** Opens with the reason field showing (the caller already asked to delete). */
  readonly initiallyOpen?: boolean;
  readonly onCancel?: () => void;
  readonly testID: string;
}

/**
 * Deleting entries that never reached the server (security review S4, clinical review C2): the
 * button names the count, a reason is required, a confirmation names the count again, and the
 * vault asks for device authentication before anything is deleted and keeps a tombstone.
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
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    const problem = checkDiscardReason(reason);
    if (problem) {
      setError(t(problem.key, problem.values));
      return;
    }
    setError(null);
    Alert.alert(confirmTitle, confirmBody, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: confirmLabel ?? t("mobile.held.discardConfirm"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          onConfirm(reason.trim())
            .catch((caught: unknown) =>
              setError(
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
      <TextField
        label={reasonLabel}
        hint={t("mobile.discard.reasonHint")}
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={DISCARD_REASON_LIMITS.max}
        errorText={error}
        testID={`${testID}-reason`}
      />
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
          setReason("");
          setError(null);
          onCancel?.();
        }}
        fullWidth
        testID={`${testID}-cancel`}
      />
    </View>
  );
}
