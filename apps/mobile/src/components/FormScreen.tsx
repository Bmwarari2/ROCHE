import { Button, Text, useTheme } from "@harbour/ui-native";
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { t } from "../i18n/t";
import { CarePersonHeader } from "./CarePersonHeader";
import { Screen } from "./Screen";

interface FormScreenProps {
  readonly personId: string;
  readonly testID: string;
  readonly children: ReactNode;
  /** Shown above the form when a save was refused for missing or wrong answers. */
  readonly showErrors: boolean;
  /** Shown when the entry could not be written to the device. */
  readonly saveFailed: boolean;
  readonly saving: boolean;
  /** Left out on a screen that only chooses what to record. */
  readonly onSave?: () => void;
}

/**
 * Layout for the Care mode forms: the point-of-care header first (HZ-001), the form, then the
 * save button in the lower part of the screen. Saving writes to the device; the upload follows.
 */
export function FormScreen({
  personId,
  testID,
  children,
  showErrors,
  saveFailed,
  saving,
  onSave,
}: FormScreenProps) {
  const theme = useTheme();
  return (
    <Screen testID={testID}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}
          keyboardShouldPersistTaps="handled"
        >
          <CarePersonHeader personId={personId} />
          {showErrors ? (
            <Text tone="danger" accessibilityRole="alert" testID="form-errors">
              {t("mobile.form.checkErrors")}
            </Text>
          ) : null}
          {saveFailed ? (
            <Text tone="danger" accessibilityRole="alert" testID="form-save-failed">
              {t("mobile.form.saveFailed")}
            </Text>
          ) : null}
          {children}
          <View style={{ paddingTop: theme.space[1], paddingBottom: theme.space[4] }}>
            {onSave ? (
              <Button
                label={t("common.save")}
                onPress={onSave}
                loading={saving}
                fullWidth
                haptic="success"
                testID="save-entry"
              />
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
