/**
 * What the point-of-care header shows (HZ-001, HZ-007, HZ-015, HZ-016; clinical reviews C3 and
 * C11): built from the rows on the device, so the header component and its render test use the
 * same props.
 */
import type { PersonHeaderProps } from "@harbour/ui-native";
import type { PersonView } from "../people/person-view";
import {
  type AdvanceCareRow,
  iddsiFlags,
  type ProfileLevels,
  resuscitationDetails,
  resuscitationFlag,
} from "./person-summary";

export interface CarePersonHeaderModel {
  readonly props: Omit<PersonHeaderProps, "photo" | "testID">;
  /** Where the resuscitation decision comes from, who made it and any overdue review. */
  readonly details: readonly string[];
}

export function carePersonHeaderModel(input: {
  readonly person: PersonView;
  readonly advanceCare: readonly AdvanceCareRow[];
  readonly profile: ProfileLevels | null;
  readonly profileLoaded: boolean;
  /** Today's UK date, yyyy-mm-dd. */
  readonly today: string;
}): CarePersonHeaderModel {
  const { flag, status } = resuscitationFlag(input.advanceCare, input.today);
  const person = input.person;
  return {
    props: {
      preferredName: person.preferredName,
      givenName: person.givenName,
      familyName: person.familyName,
      room: person.room,
      dateOfBirth: person.dateOfBirth,
      nhsNumber: person.nhsNumber,
      allergyStatus: person.allergyStatus,
      allergyCount: person.allergyCount,
      communicationNeeds: person.communicationNeeds,
      additionalFlags: [flag, ...iddsiFlags(input.profile, input.profileLoaded)],
    },
    details: resuscitationDetails(status),
  };
}
