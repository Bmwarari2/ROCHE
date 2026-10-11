import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextField } from "../TextField/TextField";
import { Toggle } from "../Toggle/Toggle";
import { StepperForm, type StepperFormStep } from "./StepperForm";

interface AdmissionValues {
  fullName: string;
  preferredName: string;
  dateOfBirth: string;
  contactName: string;
  contactPhone: string;
  largePrint: boolean;
}

const steps: StepperFormStep<AdmissionValues>[] = [
  {
    id: "person",
    title: "About the person",
    description: "Use the name they like to be called.",
    validate: (values) => (values.fullName.trim() ? null : "Enter the person's full name"),
    content: ({ values, setValue }) => (
      <>
        <TextField
          label="Full name"
          value={values.fullName}
          onChange={(event) => setValue("fullName", event.target.value)}
        />
        <TextField
          label="Preferred name"
          value={values.preferredName}
          onChange={(event) => setValue("preferredName", event.target.value)}
        />
        <TextField
          label="Date of birth"
          hint="For example, 02/04/1938"
          inputMode="numeric"
          value={values.dateOfBirth}
          onChange={(event) => setValue("dateOfBirth", event.target.value)}
        />
      </>
    ),
  },
  {
    id: "contact",
    title: "Next of kin",
    content: ({ values, setValue }) => (
      <>
        <TextField
          label="Name"
          value={values.contactName}
          onChange={(event) => setValue("contactName", event.target.value)}
        />
        <TextField
          label="Phone number"
          type="tel"
          value={values.contactPhone}
          onChange={(event) => setValue("contactPhone", event.target.value)}
        />
      </>
    ),
  },
  {
    id: "needs",
    title: "Communication needs",
    content: ({ values, setValue }) => (
      <Toggle
        label="Large print records"
        description="Printed records and letters use large print."
        checked={values.largePrint}
        onCheckedChange={(checked) => setValue("largePrint", checked)}
      />
    ),
  },
];

const initialValues: AdmissionValues = {
  fullName: "Ada Example",
  preferredName: "Ada",
  dateOfBirth: "02/04/1938",
  contactName: "Ben Sample",
  contactPhone: "",
  largePrint: false,
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const meta = {
  title: "Product shell/Stepper form",
  component: StepperForm<AdmissionValues>,
  args: {
    title: "Admission",
    steps,
    initialValues,
    onAutosave: () => wait(600),
    onSubmit: () => wait(600),
    submitLabel: "Finish admission",
  },
} satisfies Meta<typeof StepperForm<AdmissionValues>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SecondStep: Story = {
  args: { initialStep: 1 },
};

export const AutosaveFails: Story = {
  args: {
    onAutosave: async () => {
      await wait(400);
      throw new Error("Network unavailable");
    },
  },
};

export const WithoutAutosave: Story = {
  args: { onAutosave: undefined, initialStep: 2 },
};
