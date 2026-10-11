import type { Meta, StoryObj } from "@storybook/react-vite";
import { DateTimeInput } from "./DateTimeInput";

const meta = {
  title: "Primitives/Date and time input",
  component: DateTimeInput,
  args: {
    legend: "When did it happen?",
    hint: "UK time, 24-hour clock: 14 30 is half past two in the afternoon",
    name: "occurredAt",
    defaultValue: { day: "11", month: "10", year: "2026", hour: "14", minute: "05" },
  },
} satisfies Meta<typeof DateTimeInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The clocks went back over 01:30 on 25/10/2026: a required question asks which 01:30. */
export const RepeatedHour: Story = {
  args: { defaultValue: { day: "25", month: "10", year: "2026", hour: "01", minute: "30" } },
};

export const RepeatedHourNotAnswered: Story = {
  args: {
    defaultValue: { day: "25", month: "10", year: "2026", hour: "01", minute: "30" },
    error: "Choose which 01:30 it was: the clocks went back that night",
    errorParts: ["fold"],
  },
};

/** The clocks went forward over 01:30 on 29/03/2026: that time never happened. */
export const SkippedHour: Story = {
  args: {
    defaultValue: { day: "29", month: "03", year: "2026", hour: "01", minute: "30" },
    error:
      "The clocks went forward an hour at 01:00 on 29/03/2026, so 01:30 did not happen in the UK. Check the time.",
    errorParts: ["hour", "minute"],
  },
};

export const MissingTime: Story = {
  args: {
    defaultValue: { day: "11", month: "10", year: "2026" },
    error: "Enter the time, in hours and minutes",
    errorParts: ["hour", "minute"],
  },
};
