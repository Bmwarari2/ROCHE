import { Avatar, PersonFlags, Text, useTheme } from "@harbour/ui-native";
import type { HeaderFlag } from "@harbour/ui-native/logic";
import { type ImageURISource, View } from "react-native";
import type { PersonView } from "../people/person-view";

/**
 * What the pinned identity bar draws (HZ-001; clinical reviews C7 and round 3 M4): the photo, the
 * name the person is known by with the family name, allergies, communication needs and the
 * resuscitation status, each flag an icon plus words. Pure, so it is rendered in tests from the
 * device's own rows (`identity-bar.render.test.ts`).
 */
export function IdentityBarView({
  person,
  photo,
  resuscitation,
}: {
  readonly person: PersonView;
  readonly photo: ImageURISource | null;
  readonly resuscitation: HeaderFlag;
}) {
  const theme = useTheme();
  return (
    <View
      testID="identity-bar"
      accessible
      accessibilityRole="header"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space[1.5],
        paddingHorizontal: theme.space[2],
        paddingVertical: theme.space[1],
        backgroundColor: theme.colors.card,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Avatar
        photo={photo}
        name={{
          preferredName: person.preferredName,
          givenName: person.givenName,
          familyName: person.familyName,
        }}
        size={36}
        testID="identity-bar-photo"
      />
      <View style={{ flex: 1, gap: theme.space[0.5] }}>
        <Text emphasis numberOfLines={1} selectable={false} testID="identity-bar-name">
          {person.displayName}
        </Text>
        <PersonFlags
          allergyStatus={person.allergyStatus}
          allergyCount={person.allergyCount}
          communicationNeedsCount={person.communicationNeeds.length}
          context="record"
          additionalFlags={[resuscitation]}
          testID="identity-bar-flags"
        />
      </View>
    </View>
  );
}
