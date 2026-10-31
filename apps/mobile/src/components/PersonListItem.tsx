import { Avatar, type HeaderFlag, ListItem, PersonFlags } from "@harbour/ui-native";
import { memo } from "react";
import { t } from "../i18n/t";
import type { PersonView } from "../people/person-view";
import { usePersonPhoto } from "../people/use-person-photo";

interface PersonListItemProps {
  readonly person: PersonView;
  readonly onOpen: (personId: string) => void;
  /** Further flags, such as the resuscitation status on Today (HZ-015). */
  readonly additionalFlags?: readonly HeaderFlag[];
  /** On a tablet, whether this person's record is the one shown beside the list (MOB-013). */
  readonly selected?: boolean;
  /** On a tablet, the row opens the record beside the list rather than over it. */
  readonly opensBeside?: boolean;
}

/** A People list row: photo or initials, known-as name, room, allergy and communication flags. */
export const PersonListItem = memo(function PersonListItem({
  person,
  onOpen,
  additionalFlags = [],
  selected = false,
  opensBeside = false,
}: PersonListItemProps) {
  const photo = usePersonPhoto(person.id, person.photoDocumentId);
  return (
    <ListItem
      testID={`person-row-${person.id}`}
      title={person.displayName}
      subtitle={person.subtitle}
      leading={
        <Avatar
          photo={photo}
          name={{
            preferredName: person.preferredName,
            givenName: person.givenName,
            familyName: person.familyName,
          }}
          size={48}
        />
      }
      accessories={
        <PersonFlags
          allergyStatus={person.allergyStatus}
          allergyCount={person.allergyCount}
          communicationNeedsCount={person.communicationNeeds.length}
          context="list"
          additionalFlags={additionalFlags}
          testID={`person-row-${person.id}-flags`}
        />
      }
      accessibilityLabel={[
        person.accessibilityLabel,
        ...additionalFlags.map((f) => f.accessibilityLabel ?? f.label),
      ].join(". ")}
      accessibilityHint={opensBeside ? t("mobile.split.openHint") : "Opens this person's record"}
      showChevron={!opensBeside}
      selected={selected}
      selectedLabel={t("mobile.split.shown")}
      onPress={() => onOpen(person.id)}
    />
  );
});
