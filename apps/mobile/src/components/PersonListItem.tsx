import { Avatar, ListItem, PersonFlags } from "@harbour/ui-native";
import { memo } from "react";
import type { PersonView } from "../people/person-view";
import { usePersonPhoto } from "../people/use-person-photo";

interface PersonListItemProps {
  readonly person: PersonView;
  readonly onOpen: (personId: string) => void;
}

/** A People list row: photo or initials, known-as name, room, allergy and communication flags. */
export const PersonListItem = memo(function PersonListItem({
  person,
  onOpen,
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
          testID={`person-row-${person.id}-flags`}
        />
      }
      accessibilityLabel={person.accessibilityLabel}
      accessibilityHint="Opens this person's record"
      onPress={() => onOpen(person.id)}
    />
  );
});
