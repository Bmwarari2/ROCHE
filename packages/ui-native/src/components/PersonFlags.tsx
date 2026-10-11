import { StyleSheet, View } from "react-native";
import { communicationFlagLabel, describeAllergyFlag } from "../logic/person";
import { useTheme } from "../theme/ThemeProvider";
import { iconByName, MessageSquareText } from "./icons";
import { FlagChip } from "./StatusChip";

export interface PersonFlagsProps {
  /** `person.allergy_status`: unknown, no_known_allergies or has_allergies. */
  readonly allergyStatus: string | null | undefined;
  /** Active allergy rows on the device for this person. */
  readonly allergyCount: number;
  readonly communicationNeedsCount: number;
  /**
   * Lists pass "list" to hide the calm "No known allergies" chip and limit alert fatigue (HZ-005);
   * record screens pass "record" so every allergy state is always shown (HZ-007).
   */
  readonly context?: "list" | "record";
  readonly testID?: string;
}

/** Allergy and communication-needs flags, each an icon plus words, never colour alone. */
export function PersonFlags({
  allergyStatus,
  allergyCount,
  communicationNeedsCount,
  context = "record",
  testID = "person-flags",
}: PersonFlagsProps) {
  const theme = useTheme();
  const allergy = describeAllergyFlag(allergyStatus, allergyCount);
  const showAllergy = context === "record" || allergy.showInLists;
  if (!showAllergy && communicationNeedsCount <= 0) return null;

  return (
    <View testID={testID} style={[styles.row, { gap: theme.space[1] }]}>
      {showAllergy ? (
        <FlagChip
          tone={allergy.tone}
          icon={iconByName(allergy.icon)}
          label={allergy.label}
          accessibilityLabel={allergy.accessibilityLabel}
          testID={`${testID}-allergies`}
        />
      ) : null}
      {communicationNeedsCount > 0 ? (
        <FlagChip
          tone="info"
          icon={MessageSquareText}
          label={communicationFlagLabel(communicationNeedsCount)}
          testID={`${testID}-communication`}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
});
