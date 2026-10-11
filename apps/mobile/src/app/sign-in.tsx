import { Button, Text, useHaptics, useTheme } from "@harbour/ui-native";
import { useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  type TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HeldWorkOwnerError } from "../app-state/held-work";
import { useSession } from "../app-state/session";
import { useVault } from "../app-state/vault";
import { AuthError, type TwoFactorChallenge } from "../auth/auth-client";
import { authClient } from "../auth/clients";
import { Card } from "../components/Card";
import { TextField } from "../components/TextField";
import { appEnv } from "../config/app-env";
import { DEMO_TOTP_CODE } from "../demo/demo-auth";
import { t } from "../i18n/t";

type Step =
  | { readonly kind: "credentials" }
  | { readonly kind: "totp"; readonly challenge: TwoFactorChallenge };

function messageFor(error: unknown): string {
  if (error instanceof AuthError || error instanceof HeldWorkOwnerError) return error.message;
  return new AuthError("unexpected").message;
}

/**
 * Entries kept on the device after the session ended (HZ-006): only their owner can sign in and
 * send them. "Sign out and delete N unsent entries" removes them for good after a confirmation that
 * names the count.
 */
function HeldEntries({ entries }: { readonly entries: number | null }) {
  const theme = useTheme();
  const vault = useVault();
  const [deleting, setDeleting] = useState(false);

  const confirmDiscard = () => {
    Alert.alert(
      entries === null
        ? t("mobile.held.discardTitleUnknown")
        : t("mobile.held.discardTitle", { count: entries }),
      t("mobile.held.discardBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("mobile.held.discardConfirm"),
          style: "destructive",
          onPress: () => {
            setDeleting(true);
            vault.discardHeld().finally(() => setDeleting(false));
          },
        },
      ],
    );
  };

  return (
    <Card testID="held-entries">
      <View accessible accessibilityRole="alert" style={{ gap: theme.space[1] }}>
        <Text emphasis>
          {entries === null
            ? t("mobile.held.titleUnknown")
            : t("mobile.held.title", { count: entries })}
        </Text>
        <Text variant="bodyDense">{t("mobile.held.body")}</Text>
      </View>
      <Button
        label={
          entries === null
            ? t("mobile.held.discardUnknown")
            : t("mobile.held.discard", { count: entries })
        }
        variant="destructive"
        onPress={confirmDiscard}
        loading={deleting}
        fullWidth
        testID="held-discard-button"
      />
    </Card>
  );
}

/** Email and password, then the authenticator code when the account has TOTP. */
export default function SignInScreen() {
  const theme = useTheme();
  const haptics = useHaptics();
  const session = useSession();
  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  const finish = async (token: string) => {
    await session.completeSignIn(token);
    haptics?.success();
  };

  const submitCredentials = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signInWithEmail(email, password);
      if (result.kind === "two_factor_required") {
        setStep({ kind: "totp", challenge: result.challenge });
        setPassword("");
      } else {
        setPassword("");
        await finish(result.token);
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (busy || step.kind !== "totp") return;
    setBusy(true);
    setError(null);
    try {
      const token = await authClient.verifyTotp(step.challenge, code);
      setCode("");
      await finish(token);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView
      style={[styles.fill, { backgroundColor: theme.colors.bg }]}
      testID="sign-in-screen"
    >
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { padding: theme.space[3], gap: theme.space[3] }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ gap: theme.space[1] }}>
            <Text variant="title" accessibilityRole="header">
              Sign in to Harbour
            </Text>
            <Text tone="secondary">
              {step.kind === "credentials"
                ? "Use the email address and password from your care provider."
                : "Enter the 6-digit code from your authenticator app."}
            </Text>
          </View>

          {session.held ? <HeldEntries entries={session.held.entries} /> : null}

          {session.notice ? (
            <Text tone="warning" accessibilityRole="alert" testID="sign-in-notice">
              {session.notice}
            </Text>
          ) : null}

          {appEnv.demoMode ? (
            <Text variant="bodyDense" tone="secondary" testID="demo-sign-in-hint">
              Demo mode: any email address and password will sign in. Include "+totp" in the email
              address to try the code step (code {DEMO_TOTP_CODE}).
            </Text>
          ) : null}

          {step.kind === "credentials" ? (
            <View style={{ gap: theme.space[2] }}>
              <TextField
                label="Email address"
                testID="email-input"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="username"
                keyboardType="email-address"
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                editable={!busy}
              />
              <TextField
                ref={passwordRef}
                label="Password"
                testID="password-input"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={() => {
                  void submitCredentials();
                }}
                editable={!busy}
                errorText={error}
              />
            </View>
          ) : (
            <TextField
              label="Authenticator code"
              testID="totp-input"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={7}
              returnKeyType="go"
              onSubmitEditing={() => {
                void submitCode();
              }}
              editable={!busy}
              errorText={error}
            />
          )}

          <View style={{ gap: theme.space[1.5] }}>
            {step.kind === "credentials" ? (
              <Button
                label="Sign in"
                onPress={() => {
                  void submitCredentials();
                }}
                loading={busy}
                disabled={!email.trim() || !password}
                fullWidth
                testID="sign-in-button"
              />
            ) : (
              <>
                <Button
                  label="Continue"
                  onPress={() => {
                    void submitCode();
                  }}
                  loading={busy}
                  disabled={code.replace(/\s+/g, "").length !== 6}
                  fullWidth
                  testID="totp-continue-button"
                />
                <Button
                  label="Start again"
                  variant="secondary"
                  onPress={() => {
                    setStep({ kind: "credentials" });
                    setCode("");
                    setError(null);
                  }}
                  fullWidth
                  testID="totp-back-button"
                />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flexGrow: 1, justifyContent: "flex-end" },
});
