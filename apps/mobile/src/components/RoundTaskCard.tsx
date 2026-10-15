import { Button, FlagChip, iconByName, StatusChip, Text, useTheme } from "@harbour/ui-native";
import { useState } from "react";
import { View } from "react-native";
import type { FieldError } from "../care/entries";
import { TASK_REASON_MAX } from "../care/round-actions";
import { type RoundItem, roundRefusalText } from "../care/round-view";
import { t } from "../i18n/t";
import { Card } from "./Card";
import { TextField } from "./TextField";

export interface RoundTaskCardProps {
  readonly item: RoundItem;
  /** Whether the member manages tasks on the web, so a refusal says who to tell (or not). */
  readonly manager: boolean;
  /** Writes the move on this device: the problem to show, or null once it waits to upload. */
  readonly onMark: (to: "done" | "skipped", reason: string) => Promise<FieldError | null>;
  /** Opens the person's record to record the entry the task asks for. */
  readonly onRecordEvidence: (item: RoundItem) => void;
}

/**
 * One open task on the round (care.md section 6): what it is, for whom, when, its status as an
 * icon and a word, and what the carer may do. "Not done" asks why before anything is saved; a
 * task that needs evidence is done by recording the entry it asks for; a task already marked or
 * whose evidence waits to upload offers nothing, so it is never recorded twice (HZ-029). Buttons
 * are 44 pt targets.
 */
export function RoundTaskCard({ item, manager, onMark, onRecordEvidence }: RoundTaskCardProps) {
  const theme = useTheme();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const mark = async (to: "done" | "skipped") => {
    setSaving(true);
    setProblem(null);
    try {
      const error = await onMark(to, to === "skipped" ? reason : "");
      if (error) setProblem(roundRefusalText(error, manager));
      else {
        setAsking(false);
        setReason("");
      }
    } catch {
      setProblem(t("mobile.round.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const chip =
    item.chip.kind === "status" ? (
      <StatusChip
        status={item.chip.status}
        label={item.chip.label}
        testID={`round-${item.id}-status`}
      />
    ) : (
      <FlagChip
        tone={item.chip.tone}
        icon={iconByName(item.chip.icon)}
        label={item.chip.label}
        testID={`round-${item.id}-status`}
      />
    );

  return (
    <Card testID={`round-${item.id}`}>
      <View accessible style={{ gap: theme.space[0.5] }}>
        <Text emphasis>{item.title}</Text>
        {item.person ? <Text>{item.person}</Text> : null}
        {item.when ? (
          <Text variant="bodyDense" tone="secondary">
            {item.when}
          </Text>
        ) : null}
      </View>
      {chip}
      {item.notices.map((notice) => (
        <Text key={notice} variant="bodyDense" testID={`round-${item.id}-notice`}>
          {notice}
        </Text>
      ))}
      {item.action === "evidence" ? (
        <View style={{ gap: theme.space[1] }}>
          <Text variant="bodyDense">{t("mobile.round.evidenceRequired")}</Text>
          {item.personId ? (
            <Button
              label={t("mobile.round.recordEvidence")}
              accessibilityHint={t("mobile.round.recordEvidenceHint")}
              variant="secondary"
              onPress={() => onRecordEvidence(item)}
              testID={`round-${item.id}-evidence`}
            />
          ) : null}
        </View>
      ) : null}
      {item.action === "mark" && !asking ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
          <Button
            label={t("mobile.round.markDone")}
            accessibilityLabel={t("mobile.round.markDoneLabel", { title: item.title })}
            onPress={() => void mark("done")}
            loading={saving}
            testID={`round-${item.id}-done`}
          />
          <Button
            label={t("mobile.round.markNotDone")}
            accessibilityLabel={t("mobile.round.markNotDoneLabel", { title: item.title })}
            variant="secondary"
            onPress={() => {
              setProblem(null);
              setAsking(true);
            }}
            disabled={saving}
            testID={`round-${item.id}-not-done`}
          />
        </View>
      ) : null}
      {item.action === "mark" && asking ? (
        <View style={{ gap: theme.space[1] }}>
          <TextField
            label={t("mobile.round.reasonLabel")}
            hint={t("mobile.round.reasonHint")}
            value={reason}
            onChangeText={setReason}
            multiline
            maxLength={TASK_REASON_MAX}
            testID={`round-${item.id}-reason`}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
            <Button
              label={t("mobile.round.saveNotDone")}
              onPress={() => void mark("skipped")}
              loading={saving}
              testID={`round-${item.id}-save`}
            />
            <Button
              label={t("mobile.round.cancel")}
              variant="secondary"
              onPress={() => {
                setAsking(false);
                setProblem(null);
              }}
              disabled={saving}
              testID={`round-${item.id}-cancel`}
            />
          </View>
        </View>
      ) : null}
      {problem ? (
        <Text tone="danger" accessibilityRole="alert" testID={`round-${item.id}-problem`}>
          {problem}
        </Text>
      ) : null}
    </Card>
  );
}
