import type { Meta, StoryObj } from "@storybook/react-vite";
import { Toggle } from "./Toggle";

const meta = {
  title: "Product shell/Toggle",
  component: Toggle,
  args: {
    label: "Email me when a care note is corrected",
  },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};

export const On: Story = {
  args: { defaultChecked: true },
};

export const WithDescription: Story = {
  args: {
    label: "Show the family portal",
    description: "Family members you invite can see photos and the activity diary.",
    defaultChecked: true,
  },
};

export const Disabled: Story = {
  args: {
    label: "Large print records",
    description: "Set by the person's communication needs.",
    defaultChecked: true,
    disabled: true,
  },
};
