import { Button, Text, useHaptics, useTheme } from "@harbour/ui-native";
import { useEffect, useRef, useState } from "react";
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
import { heldView } from "../app-state/held-view";
import {
  checkDiscardReason,
  type DiscardReason,
  HeldDiscardNotAllowedError,
  type HeldWork,
  HeldWorkOwnerError,
} from "../app-state/held-work";
import { useSession } from "../app-state/session";
import { useVault } from "../app-state/vault";
import { AuthError, type TwoFactorChallenge } from "../auth/auth-client";
import { authClient } from "../auth/clients";
import type { FieldError } from "../care/entries";
import { Card } from "../components/Card";
import { DiscardReasonFields, EMPTY_REASON } from "../components/DeleteWithReason";
import { TextField } from "../components/TextField";
import { appEnv } from "../config/app-env";
import { DEMO_TOTP_CODE } from "../demo/demo-auth";
import { t } from "../i18n/t";

type Step =
  | { readonly kind: "credentials" }
  | { readonly kind: "totp"; readonly challenge: TwoFactorChallenge };

/**
 * Signing in to use Harbour; or, with held entries, to delete them as their owner or a manager, or
 * to send them in their owner's name as a manager (or the owner, on a revoked device).
 */
type Purpose = "signIn" | "discard" | "handOver";

function messageFor(error: unknown): string {
  if (
    error instanceof AuthError ||
    error instanceof HeldWorkOwnerError ||
    error instanceof HeldDiscardNotAllowedError
  ) {
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return new AuthError("unexpected").message;
}

/** Re-renders every minute, so the hold's final warning and escalation show on time. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

/**
 * Entries kept on the device after the session ended (HZ-006, HZ-040): whose they are (C8), how
 * many, and where the hold stands: until the deadline, a final warning in the last day, then a
 * manager must resolve them (M3). Nothing is deleted automatically. Only their owner can sign in
 * and send them. Deleting them needs the owner or a manager to sign in on the device (M2), a coded
 * reason, a confirmation naming the count and device authentication.
 */
function HeldEntries({
  held,
  discarding,
  onDiscard,
  onHandOver,
}: {
  readonly held: HeldWork;
  readonly discarding: boolean;
  readonly onDiscard: () => void;
  readonly onHandOver: () => void;
}) {
  const theme = useTheme();
  const view = heldView(held, useMinuteClock());

  return (
    <Card testID="held-entries">
      <View accessible accessibilityRole="alert" style={{ gap: theme.space[1] }}>
        <Text emphasis>{view.title}</Text>
        <Text testID="held-owner">{view.owner}</Text>
        <Text variant="bodyDense">{view.body}</Text>
        {view.urgent ? (
          <Text tone="danger" emphasis testID={`held-${view.state}`}>
            {view.time}
          </Text>
        ) : (
          <Text variant="bodyDense" testID="held-deadline">
            {view.time}
          </Text>
        )}
      </View>
      {discarding || held.uploadBlocked || !held.tenantUserId ? null : (
        <Button
          label={view.handOverLabel}
          variant="secondary"
          onPress={onHandOver}
          fullWidth
          testID="held-hand-over"
        />
      )}
      {discarding ? null : (
        <Button
          label={view.discardLabel}
          variant="destructive"
          onPress={onDiscard}
          fullWidth
          testID="held-discard"
        />
      )}
    </Card>
  );
}

/** Email and password, then the authenticator code when the account has TOTP. */
export default function SignInScreen() {
  const theme = useTheme();
  const haptics = useHaptics();
  const session = useSession();
  const vault = useVault();
  const [purpose, setPurpose] = useState<Purpose>("signIn");
  const [choice, setChoice] = useState<DiscardReason>(EMPTY_REASON);
  const [reasonError, setReasonError] = useState<FieldError | null>(null);
  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  const held = session.held;
  const discarding = purpose === "discard" && held !== null;
  const handingOver = purpose === "handOver" && held !== null;
  const actingOnHeld = discarding || handingOver;

  const backToSignIn = () => {
    setPurpose("signIn");
    setChoice(EMPTY_REASON);
    setReasonError(null);
    setStep({ kind: "credentials" });
    setCode("");
    setError(null);
  };

  /** The signer is known only after signing in: the confirmation names the count, then deletes. */
  const confirmDiscard = (token: string) =>
    new Promise<void>((resolve) => {
      const view = held ? heldView(held, new Date()) : null;
      Alert.alert(
        view?.confirmTitle ?? t("mobile.held.discardTitleUnknown"),
        t("mobile.held.discardBody"),
        [
          {
            text: t("common.cancel"),
            style: "cancel",
            onPress: () => {
              void authClient.signOut(token).catch(() => undefined);
              resolve();
            },
          },
          {
            text: t("mobile.held.discardConfirm"),
            style: "destructive",
            onPress: () => {
              vault
                .discardHeld(choice, token)
                .then(() => {
                  haptics?.success();
                  backToSignIn();
                })
                .catch((caught: unknown) => setError(messageFor(caught)))
                .finally(resolve);
            },
          },
        ],
      );
    });

  const finish = async (token: string) => {
    if (discarding) {
      await confirmDiscard(token);
      return;
    }
    if (handingOver) {
      // Sent in the owner's name; the signer's session ends whatever happens.
      const message = await vault.handOverHeld(token);
      haptics?.success();
      backToSignIn();
      if (message) Alert.alert(t("mobile.held.handOverSignInTitle"), message);
      return;
    }
    await session.completeSignIn(token);
    haptics?.success();
  };

  const submitCredentials = async () => {
    if (busy) return;
    if (discarding) {
      const problem = checkDiscardReason(choice);
      setReasonError(problem);
      if (problem) return;
    }
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
              {discarding
                ? t("mobile.held.discardSignInTitle")
                : handingOver
                  ? t("mobile.held.handOverSignInTitle")
                  : "Sign in to Harbour"}
            </Text>
            <Text tone="secondary">
              {discarding
                ? t("mobile.held.discardSignInBody")
                : handingOver
                  ? t("mobile.held.handOverSignInBody")
                  : step.kind === "credentials"
                    ? "Use the email address and password from your care provider."
                    : "Enter the 6-digit code from your authenticator app."}
            </Text>
          </View>

          {held ? (
            <HeldEntries
              held={held}
              discarding={actingOnHeld}
              onDiscard={() => {
                setPurpose("discard");
                setError(null);
              }}
              onHandOver={() => {
                setPurpose("handOver");
                setError(null);
              }}
            />
          ) : null}

          {discarding ? (
            <DiscardReasonFields
              label={t("mobile.discard.reasonLabel")}
              value={choice}
              onChange={setChoice}
              error={reasonError}
              testID="held-discard"
            />
          ) : null}

          {session.notice && !actingOnHeld ? (
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
                label={
                  discarding
                    ? t("mobile.held.discardSignIn")
                    : handingOver
                      ? t("mobile.held.handOverSignIn")
                      : "Sign in"
                }
                variant={discarding ? "destructive" : "primary"}
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
            {actingOnHeld ? (
              <Button
                label={t("common.cancel")}
                variant="secondary"
                onPress={backToSignIn}
                fullWidth
                testID="held-discard-cancel"
              />
            ) : null}
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
