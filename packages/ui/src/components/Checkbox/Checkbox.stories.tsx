import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./Checkbox";

const meta = {
  title: "Primitives/Checkbox",
  component: Checkbox,
  args: { label: "Skin checked" },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = { args: { defaultChecked: true } };

export const WithHint: Story = {
  args: {
    label: "Ada refused the drink",
    hint: "Record the amount offered. A refusal is shown at handover.",
  },
};

export const WithError: Story = {
  args: {
    label: "I have checked the person's identity",
    error: "Check the photo and date of birth before you save",
  },
};

export const Disabled: Story = { args: { disabled: true } };
