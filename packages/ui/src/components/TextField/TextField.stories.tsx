import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextField } from "./TextField";

const meta = {
  title: "Primitives/Text field",
  component: TextField,
  args: {
    label: "Preferred name",
    defaultValue: "Ada",
  },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithHint: Story = {
  args: {
    label: "Date of birth",
    hint: "For example, 02/04/1938",
    defaultValue: "",
    inputMode: "numeric",
  },
};

export const WithError: Story = {
  args: {
    label: "NHS number",
    hint: "10 digits, for example 999 000 0018",
    error: "Enter all 10 digits of the NHS number",
    defaultValue: "999 000",
  },
};
