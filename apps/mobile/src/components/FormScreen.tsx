import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { t } from "../i18n/t";
import { CarePersonHeader, useCarePerson } from "./CarePersonHeader";
import { FormLayout } from "./FormLayout";
import { IdentityBar } from "./IdentityBar";
import { Screen } from "./Screen";

interface FormScreenProps {
  readonly personId: string;
  /** What the form records, for example "Write a note"; the person's name is added to it. */
  readonly title: string;
  readonly testID: string;
  readonly children: ReactNode;
  /** Shown above the form when a save was refused for missing or wrong answers. */
  readonly showErrors: boolean;
  /** Shown when the entry could not be written to the device. */
  readonly saveFailed: boolean;
  readonly saving: boolean;
  /** Left out on a screen that only chooses what to record. */
  readonly onSave?: () => void;
}

/**
 * Layout for the Care mode forms (HZ-001, clinical review C7): the title names the person, a
 * compact identity bar (photo, name, allergies, communication needs, resuscitation status) stays
 * pinned while the form scrolls, the full point-of-care header opens the form, and the save button
 * sits in the lower part of the screen. Save appears only once the person has loaded, so nothing
 * is recorded against a person the screen has not shown. Saving writes to the device; the upload
 * follows. The order is `FormLayout`, rendered in tests.
 */
export function FormScreen({ personId, title, testID, children, ...form }: FormScreenProps) {
  const { person } = useCarePerson(personId);
  return (
    <Screen testID={testID}>
      <Stack.Screen
        options={{
          title: person ? t("mobile.form.titleFor", { title, name: person.displayName }) : title,
        }}
      />
      <FormLayout
        identityBar={<IdentityBar personId={personId} />}
        header={<CarePersonHeader personId={personId} />}
        personLoaded={person !== null}
        {...form}
      >
        {children}
      </FormLayout>
    </Screen>
  );
}
