import { Button, ICON_STROKE_WIDTH, iconByName, Text, useTheme } from "@harbour/ui-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { useSession } from "../../../app-state/session";
import { Screen } from "../../../components/Screen";
import { t } from "../../../i18n/t";
import { useOfflineCourse } from "../../../training/hooks";
import { isInsideFolder } from "../../../training/offline-plan";
import {
  offlineLaunchQuery,
  offlineRuntimeSource,
  parseRuntimeMessage,
} from "../../../training/offline-runtime";
import { courseFolder, launchFile } from "../../../training/store";

/**
 * A course taken offline (workforce.md section 14.5; mobile slice 72). The package's own launch
 * page runs from the phone's copy, with the offline runtime injected first; it may open only its
 * own files (anything else is stopped and said), never reaches the network, and what it reports
 * is saved on the phone and sent when there is a connection.
 */
export default function OfflineCourseScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { courseId } = useLocalSearchParams<{ courseId: string }>();
  const { me } = useSession();
  const { course, attempt, ready, tenantId, report } = useOfflineCourse(String(courseId ?? ""));
  const [blocked, setBlocked] = useState(false);
  const appName = t("app.name");
  const file = course ? launchFile(tenantId, course.manifest) : null;
  const folder = course ? courseFolder(tenantId, course.manifest.courseId).uri : "";
  // The runtime is made once per attempt: later progress must not reload the page.
  const built = useRef<{ attemptId: string; uri: string; script: string } | null>(null);
  if (course && attempt && file && built.current?.attemptId !== attempt.attemptId) {
    // The course is told the member's first name only (as on the content origin).
    const firstName = (me?.user.name ?? "").trim().split(/\s+/)[0] ?? "";
    built.current = {
      attemptId: attempt.attemptId,
      uri: `${file.uri}${offlineLaunchQuery(course.manifest.standard, course.manifest.launchQuery, attempt.attemptId)}`,
      script: offlineRuntimeSource({
        standard: course.manifest.standard,
        entry: attempt.location || attempt.suspendData ? "resume" : "ab-initio",
        location: attempt.location,
        suspendData: attempt.suspendData,
        learnerId: attempt.attemptId,
        learnerName: firstName,
      }),
    };
  }
  const source = course && attempt && file ? built.current : null;

  const Alert = iconByName("circle-alert");
  // The header names the course open, not just "Training".
  const header = course ? <Stack.Screen options={{ title: course.manifest.title }} /> : null;
  if (!ready) {
    return (
      <Screen testID="course-screen">
        <Text accessibilityLiveRegion="polite" style={{ padding: theme.space[2] }}>
          {t("mobile.training.player.loading")}
        </Text>
      </Screen>
    );
  }
  if (!source) {
    return (
      <Screen testID="course-screen">
        <View style={{ padding: theme.space[2], gap: theme.space[2] }}>
          <Text testID="course-missing">{t("mobile.training.player.missing")}</Text>
          <Button label={t("mobile.training.player.close")} onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }
  return (
    <Screen testID="course-screen">
      {header}
      <View style={{ padding: theme.space[1], gap: theme.space[1] }}>
        <Text variant="bodyDense" tone="secondary">
          {t("mobile.training.player.saved", { appName })}
        </Text>
        {blocked ? (
          <View style={{ flexDirection: "row", gap: theme.space[1], alignItems: "flex-start" }}>
            <Alert
              color={theme.colors.danger}
              size={20}
              strokeWidth={ICON_STROKE_WIDTH}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
            <Text
              variant="bodyDense"
              tone="danger"
              accessibilityRole="alert"
              style={{ flexShrink: 1 }}
              testID="course-blocked"
            >
              {t("mobile.training.blocked")}
            </Text>
          </View>
        ) : null}
      </View>
      <WebView
        source={{ uri: source.uri }}
        injectedJavaScriptBeforeContentLoaded={source.script}
        originWhitelist={["file://*"]}
        allowFileAccess
        allowingReadAccessToURL={folder}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        cacheEnabled={false}
        onShouldStartLoadWithRequest={(request) => {
          // Only the course's own files on the phone; nothing else ever loads here.
          const inside = isInsideFolder(request.url, folder);
          if (!inside) setBlocked(true);
          return inside;
        }}
        onMessage={(event) => {
          const message = parseRuntimeMessage(event.nativeEvent.data);
          if (message) void report(message);
        }}
        accessibilityLabel={course?.manifest.title}
        testID="course-webview"
      />
    </Screen>
  );
}
