import { Button, Text, useTheme } from "@harbour/ui-native";
import { usePowerSync, useQuery } from "@powersync/react";
import * as Crypto from "expo-crypto";
import { useMemo, useState } from "react";
import { AccessibilityInfo, ScrollView, View } from "react-native";
import type { TwoFactorChallenge } from "../../../auth/auth-client";
import { authClient, platformFetch } from "../../../auth/clients";
import { useTenantId } from "../../../care/hooks";
import { Screen } from "../../../components/Screen";
import { StatusLine } from "../../../components/StatusLine";
import { TextField } from "../../../components/TextField";
import { appEnv } from "../../../config/app-env";
import { t } from "../../../i18n/t";
import { newWrappedKey, pinProblems } from "../../../medicines/device-key";
import {
  DEVICE_KEYS_SQL,
  deviceKeysParams,
  enrolDeviceKey,
  keysFrom,
  saveWrappedKey,
} from "../../../medicines/device-key-store";
import { useRecordScreenProtection } from "../../../security/use-record-protection";

/**
 * Medicines PINs on this phone (ADR-0084; slice 70): who can sign a controlled drug here offline.
 * Each person, the member signed in or a witness, signs in here for this alone (with their second
 * factor: the step-up the API asks for), then chooses a PIN; the phone makes their key, Harbour
 * keeps its public half, and that sign-in is ended straight away. Needs a connection.
 */
export default function MedicinesPinsScreen() {
  useRecordScreenProtection("medicines-pins");
  const theme = useTheme();
  const db = usePowerSync();
  const tenantId = useTenantId();
  const { data: keyRows } = useQuery<{ id: string; value: string }>(
    DEVICE_KEYS_SQL,
    deviceKeysParams,
  );
  const keys = useMemo(() => keysFrom(keyRows), [keyRows]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; words: string } | null>(
    null,
  );

  const say = (tone: "success" | "danger", words: string) => {
    setMessage({ tone, words });
    AccessibilityInfo.announceForAccessibility(words);
  };

  const submit = async () => {
    const problems = pinProblems(pin, confirm);
    if (problems.length > 0) {
      say("danger", problems.map((p) => t("mobile.meds.pinProblem", { problem: p })).join(" "));
      return;
    }
    setBusy(true);
    let token: string | null = null;
    try {
      if (challenge) {
        token = await authClient.verifyTotp(challenge, code);
      } else {
        const result = await authClient.signInWithEmail(email.trim(), password);
        if (result.kind === "two_factor_required") {
          setChallenge(result.challenge);
          say("success", t("mobile.meds.pinCodeNeeded"));
          return;
        }
        token = result.token;
      }
      const me = await authClient.getMe(token, tenantId);
      if (!me.tenantUserId) throw new Error("no member");
      const sealed = newWrappedKey(me.tenantUserId, pin, (n) => Crypto.getRandomBytes(n));
      const enrolled = await enrolDeviceKey({
        apiUrl: appEnv.apiUrl,
        fetch: platformFetch,
        token,
        tenantId,
        deviceId: await db.getClientId(),
        publicKey: sealed.publicKey,
      });
      if (enrolled.kind !== "enrolled") {
        say(
          "danger",
          enrolled.kind === "offline"
            ? t("mobile.meds.pinOffline")
            : t("mobile.meds.pinRefused", { code: enrolled.code ?? String(enrolled.status) }),
        );
        return;
      }
      await saveWrappedKey(db, { ...sealed, keyId: enrolled.keyId, name: me.user.name });
      setEmail("");
      setPassword("");
      setCode("");
      setPin("");
      setConfirm("");
      setChallenge(null);
      say("success", t("mobile.meds.pinSet", { person: me.user.name }));
    } catch {
      say("danger", t("mobile.meds.pinSignInFailed"));
    } finally {
      // The sign-in was for this alone: it ends here.
      if (token) void authClient.signOut(token);
      setBusy(false);
    }
  };

  return (
    <Screen testID="medicines-pins">
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[1.5] }}>
        <Text>{t("mobile.meds.pinIntro")}</Text>
        <Text variant="callout" accessibilityRole="header">
          {t("mobile.meds.pinWho")}
        </Text>
        {keys.length === 0 ? (
          <Text tone="secondary">{t("mobile.meds.pinNone")}</Text>
        ) : (
          keys.map((k) => (
            <Text key={k.memberId}>{k.name ?? t("mobile.meds.personNotOnPhone")}</Text>
          ))
        )}
        <View style={{ gap: theme.space[1] }}>
          {challenge ? (
            <TextField
              label={t("mobile.meds.pinCode")}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              autoComplete="one-time-code"
            />
          ) : (
            <>
              <TextField
                label={t("mobile.meds.pinEmail")}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
              />
              <TextField
                label={t("mobile.meds.pinPassword")}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="current-password"
              />
            </>
          )}
          <TextField
            label={t("mobile.meds.pinNew")}
            hint={t("mobile.meds.pinHint")}
            value={pin}
            onChangeText={setPin}
            secureTextEntry
            keyboardType="number-pad"
          />
          <TextField
            label={t("mobile.meds.pinConfirm")}
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            keyboardType="number-pad"
          />
        </View>
        {message ? <StatusLine tone={message.tone}>{message.words}</StatusLine> : null}
        <Button
          label={t("mobile.meds.pinSave")}
          onPress={() => void submit()}
          loading={busy}
          testID="save-pin"
        />
      </ScrollView>
    </Screen>
  );
}
