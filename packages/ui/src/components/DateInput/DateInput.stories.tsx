import type { Meta, StoryObj } from "@storybook/react-vite";
import { DateInput } from "./DateInput";

const meta = {
  title: "Primitives/Date input",
  component: DateInput,
  args: {
    legend: "Date of the assessment",
    hint: "For example, 27 3 2026",
    name: "assessedOn",
  },
} satisfies Meta<typeof DateInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithDate: Story = { args: { defaultValue: "2026-03-05" } };

export const MissingPart: Story = {
  args: {
    defaultValue: null,
    error: "The date of the assessment must include a month",
    errorParts: ["month"],
  },
};

export const NotARealDate: Story = {
  args: {
    legend: "Review date",
    error: "The review date must be a real date",
  },
};
