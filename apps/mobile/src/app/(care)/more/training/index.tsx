import { Text, useTheme } from "@harbour/ui-native";
import { useStatus } from "@powersync/react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { Card } from "../../../../components/Card";
import { Screen } from "../../../../components/Screen";
import { TrainingCourseCard } from "../../../../components/TrainingCourseCard";
import { UploadIssues } from "../../../../components/UploadIssues";
import { t } from "../../../../i18n/t";
import { useTraining } from "../../../../training/hooks";

/**
 * Training courses on the phone (workforce.md section 14.5; MOB-007, WORK-006; mobile slice 72):
 * "needs attention" first, so a course whose work was refused is never out of sight, then each
 * course with what it is on this phone. Download while there is a connection; take it without one.
 */
export default function TrainingScreen() {
  const theme = useTheme();
  const router = useRouter();
  const status = useStatus();
  const { items, progress, waiting, download, remove } = useTraining();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const appName = t("app.name");

  const onDownload = async (courseId: string) => {
    setAnswers((a) => ({ ...a, [courseId]: "" }));
    const outcome = await download(courseId);
    if (outcome.kind === "done") return;
    setAnswers((a) => ({
      ...a,
      [courseId]: outcome.kind === "refused" ? outcome.words : t("mobile.training.downloadFailed"),
    }));
  };

  const onRemove = (courseId: string) =>
    Alert.alert(t("mobile.training.removeTitle"), t("mobile.training.removeBody"), [
      { text: t("mobile.training.keep"), style: "cancel" },
      {
        text: t("mobile.training.remove"),
        style: "destructive",
        onPress: () => void remove(courseId),
      },
    ]);

  return (
    <Screen testID="training-screen">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustsScrollIndicatorInsets
        contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}
      >
        <UploadIssues />
        <Card title={t("mobile.training.title")}>
          <View accessible style={{ gap: theme.space[0.5] }}>
            <Text variant="bodyDense">{t("mobile.training.intro", { appName })}</Text>
            {!status.connected ? (
              <Text variant="bodyDense" testID="training-offline">
                {t("mobile.training.offlineList")}
              </Text>
            ) : null}
            {waiting > 0 ? (
              <Text variant="bodyDense" testID="training-waiting">
                {t("mobile.training.waiting", { count: waiting, appName })}
              </Text>
            ) : null}
          </View>
          {/* Outside the grouped view, so its live region is read on Android too. */}
          {progress ? (
            <Text variant="bodyDense" accessibilityLiveRegion="polite" testID="training-progress">
              {t("mobile.training.downloading", {
                done: String(progress.done),
                total: String(progress.total),
              })}
            </Text>
          ) : null}
        </Card>
        {items.length === 0 ? (
          <Text testID="training-none">{t("mobile.training.none")}</Text>
        ) : (
          items.map((item) => (
            <TrainingCourseCard
              key={item.courseId}
              item={item}
              answer={answers[item.courseId] || null}
              onDownload={() => void onDownload(item.courseId)}
              onOpen={() =>
                router.push({
                  pathname: "/more/training/[courseId]",
                  params: { courseId: item.courseId },
                })
              }
              onRemove={() => onRemove(item.courseId)}
            />
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
