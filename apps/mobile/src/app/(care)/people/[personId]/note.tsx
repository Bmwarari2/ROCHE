import { Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { FieldError } from "../../../../care/entries";
import { useEntryContext, useTenantId } from "../../../../care/hooks";
import {
  checkNote,
  NOTE_BODY_MAX,
  NOTE_CATEGORIES,
  NOTE_TAGS,
  type NoteCategory,
  type NoteField,
} from "../../../../care/notes";
import { NOTE_BY_ID_SQL, type NoteRow } from "../../../../care/queries";
import type { WhenChoice } from "../../../../care/time";
import { useSaveAndReturn } from "../../../../care/use-save";
import { FormScreen } from "../../../../components/FormScreen";
import { ChoiceGroup, CorrectionField, errorText, WhenField } from "../../../../components/forms";
import { TextField } from "../../../../components/TextField";
import { t } from "../../../../i18n/t";
import { useRecordScreenProtection } from "../../../../security/use-record-protection";

/** Write a daily note offline, or correct one with a reason (HZ-017). */
export default function NoteScreen() {
  useRecordScreenProtection("note");
  const theme = useTheme();
  const { personId, correct } = useLocalSearchParams<{ personId: string; correct?: string }>();
  const id = typeof personId === "string" ? personId : "";
  const correctId = typeof correct === "string" && correct ? correct : null;
  const tenantId = useTenantId();
  const context = useEntryContext(id);
  const { submit, saving, saveFailed } = useSaveAndReturn();

  const originalParams = useMemo(() => [tenantId, id, correctId ?? ""], [tenantId, id, correctId]);
  const { data: originals } = useQuery<NoteRow>(NOTE_BY_ID_SQL, originalParams);
  const original = correctId ? (originals[0] ?? null) : null;

  const [category, setCategory] = useState<NoteCategory | null>(null);
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [when, setWhen] = useState<WhenChoice>({ kind: "now" });
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Partial<Record<NoteField, FieldError>>>({});

  // A correction starts from the original's words, so only what was wrong needs changing.
  useEffect(() => {
    if (!original) return;
    setCategory((current) => current ?? (original.category as NoteCategory | null));
    setBody((current) => current || (original.body ?? ""));
  }, [original]);

  const save = () => {
    const result = checkNote(
      {
        category,
        body,
        tags,
        when,
        correction: correctId ? { supersedesId: correctId, reason } : null,
      },
      context,
      new Date(),
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    void submit("care_note", result.row);
  };

  const toggleTag = (tag: string) =>
    setTags((current) =>
      current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag],
    );

  return (
    <FormScreen
      personId={id}
      testID="note-screen"
      showErrors={Object.keys(errors).length > 0}
      saveFailed={saveFailed}
      saving={saving}
      onSave={save}
    >
      <Stack.Screen
        options={{ title: t(correctId ? "mobile.note.correctTitle" : "mobile.note.title") }}
      />
      {correctId ? (
        <CorrectionField
          original={original?.body ?? ""}
          reason={reason}
          onChange={setReason}
          error={errors.reason}
        />
      ) : null}
      <ChoiceGroup
        label={t("mobile.note.category")}
        testID="note-category"
        value={category}
        onChange={setCategory}
        options={NOTE_CATEGORIES.map((value) => ({
          value,
          label: t("mobile.note.categoryName", { category: value }),
        }))}
        error={errors.category}
      />
      <TextField
        label={t("mobile.note.body")}
        hint={t("mobile.note.bodyHint")}
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={NOTE_BODY_MAX}
        textAlignVertical="top"
        minHeight={120}
        errorText={errorText(errors.body)}
        testID="note-body"
      />
      <View style={{ gap: theme.space[1] }}>
        <Text variant="bodyDense" emphasis accessibilityRole="header">
          {t("mobile.note.tags")}
        </Text>
        {NOTE_TAGS.map((tag) => {
          const checked = tags.includes(tag);
          return (
            <Pressable
              key={tag}
              testID={`note-tag-${tag}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              onPress={() => toggleTag(tag)}
              style={{
                minHeight: theme.touchTarget,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                borderRadius: theme.radius.input,
                borderWidth: checked ? 2 : 1,
                borderColor: checked ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.card,
                paddingHorizontal: theme.space[1.5],
              }}
            >
              <Text emphasis={checked}>{t("mobile.note.tag", { tag })}</Text>
              {checked ? (
                <Text tone="accent" emphasis>
                  {t("mobile.common.selected")}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <WhenField value={when} onChange={setWhen} error={errors.when} />
    </FormScreen>
  );
}
