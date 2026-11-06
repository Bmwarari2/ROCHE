import { Button, Text, useTheme } from "@harbour/ui-native";
import { View } from "react-native";
import { t } from "../i18n/t";
import type { CourseItem } from "../training/view";
import { Card } from "./Card";

/**
 * One course in the training list on the phone (mobile slice 72): what it is on this phone, in
 * words, its size once downloaded, and what can be done with it. Downloading, opening and removing
 * are named for the course, for a screen reader.
 */
export function TrainingCourseCard({
  item,
  answer,
  onDownload,
  onOpen,
  onRemove,
}: {
  readonly item: CourseItem;
  /** Words about this course's last download (no room, failed), or null. */
  readonly answer: string | null;
  readonly onDownload: () => void;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}) {
  const theme = useTheme();
  return (
    <Card testID={`course-${item.courseId}`}>
      <View accessible style={{ gap: theme.space[0.5] }}>
        <Text emphasis accessibilityRole="header">
          {item.title}
        </Text>
        <Text variant="bodyDense" testID={`course-${item.courseId}-state`}>
          {item.stateWords}
        </Text>
        {item.size ? (
          <Text variant="bodyDense" tone="secondary">
            {t("mobile.training.size", { size: item.size })}
          </Text>
        ) : null}
      </View>
      {answer ? (
        <Text
          variant="bodyDense"
          tone="danger"
          accessibilityLiveRegion="polite"
          testID={`course-${item.courseId}-answer`}
        >
          {answer}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
        {item.canOpen ? (
          <Button
            label={t("mobile.training.start")}
            accessibilityLabel={t("mobile.training.startLabel", { title: item.title })}
            onPress={onOpen}
            testID={`course-${item.courseId}-open`}
          />
        ) : null}
        {item.canDownload ? (
          <Button
            label={t("mobile.training.download")}
            accessibilityLabel={t("mobile.training.downloadLabel", {
              title: item.title,
              size: item.size ?? "",
            })}
            onPress={onDownload}
            testID={`course-${item.courseId}-download`}
          />
        ) : null}
        {item.canRemove ? (
          <Button
            label={t("mobile.training.remove")}
            accessibilityLabel={t("mobile.training.removeLabel", { title: item.title })}
            variant="secondary"
            onPress={onRemove}
            testID={`course-${item.courseId}-remove`}
          />
        ) : null}
      </View>
    </Card>
  );
}
