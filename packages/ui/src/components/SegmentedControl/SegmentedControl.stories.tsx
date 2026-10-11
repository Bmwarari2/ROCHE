import type { Meta, StoryObj } from "@storybook/react-vite";
import { CalendarDays, List } from "lucide-react";
import { iconProps } from "../../lib/icon";
import { SegmentedControl } from "./SegmentedControl";

const meta = {
  title: "Product shell/Segmented control",
  component: SegmentedControl,
  args: {
    label: "Rota view",
    options: [
      { value: "day", label: "Day" },
      { value: "week", label: "Week" },
      { value: "month", label: "Month" },
    ],
    defaultValue: "week",
  },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const HiddenLabel: Story = {
  args: { hideLabel: true },
};

export const WithIcons: Story = {
  args: {
    label: "Care notes layout",
    options: [
      { value: "list", label: "List", icon: <List {...iconProps} /> },
      { value: "calendar", label: "Calendar", icon: <CalendarDays {...iconProps} /> },
    ],
    defaultValue: "list",
  },
};

export const WithDisabledOption: Story = {
  args: {
    options: [
      { value: "day", label: "Day" },
      { value: "week", label: "Week" },
      { value: "month", label: "Month", disabled: true },
    ],
  },
};
