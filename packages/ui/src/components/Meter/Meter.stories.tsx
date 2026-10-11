import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusChip } from "../StatusChip/StatusChip";
import { Meter } from "./Meter";

const meta = {
  title: "Product shell/Meter",
  component: Meter,
  args: {
    label: "Fluid intake today",
    value: 900,
    max: 1500,
    valueText: "900 ml of a 1,500 ml target",
    description: <StatusChip status="due" label="600 ml below the target so far" />,
  },
} satisfies Meta<typeof Meter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BelowTarget: Story = {};

export const TargetReached: Story = {
  args: {
    value: 1650,
    valueText: "1,650 ml of a 1,500 ml target",
    description: <StatusChip status="done" label="Target reached" />,
  },
};

export const Empty: Story = {
  args: {
    value: 0,
    valueText: "0 ml of a 1,500 ml target",
    description: "Nothing recorded yet today.",
  },
};
