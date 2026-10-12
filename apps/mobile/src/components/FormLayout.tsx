import { Button, Text, useTheme } from "@harbour/ui-native";
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { t } from "../i18n/t";

export interface FormLayoutProps {
  /** The compact identity bar, pinned above the scrolling form. */
  readonly identityBar: ReactNode;
  /** The full point-of-care header, which opens the form. */
  readonly header: ReactNode;
  /** True once the person has loaded: Save appears only then (C7). */
  readonly personLoaded: boolean;
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
 * The order of a Care mode form (HZ-001, clinical review C7): the identity bar outside the scroll
 * view, so it stays pinned, then the full header first inside it, the form, and Save in the lower
 * part of the screen, only once the person has loaded. Pure, so the order is proved by rendering
 * (`identity-bar.render.test.ts`).
 */
export function FormLayout({
  identityBar,
  header,
  personLoaded,
  children,
  showErrors,
  saveFailed,
  saving,
  onSave,
}: FormLayoutProps) {
  const theme = useTheme();
  return (
    <>
      {identityBar}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        testID="form-keyboard"
      >
        <ScrollView
          contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}
          keyboardShouldPersistTaps="handled"
          testID="form-scroll"
        >
          {header}
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
            {onSave && personLoaded ? (
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
    </>
  );
}
