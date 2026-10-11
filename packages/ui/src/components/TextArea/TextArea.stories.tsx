import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextArea } from "./TextArea";

const meta = {
  title: "Primitives/Text area",
  component: TextArea,
  args: {
    label: "What happened",
    defaultValue: "",
  },
} satisfies Meta<typeof TextArea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithHint: Story = {
  args: {
    label: "Handover note",
    hint: "What the next shift needs to know about Ada. Do not include other people's names.",
    defaultValue: "Ada slept well and ate a full breakfast.",
  },
};

export const WithCharacterCount: Story = {
  args: {
    label: "Reason",
    hint: "At least 20 characters. It is recorded in the audit log with your name.",
    maxLength: 200,
    defaultValue: "Covering Rowan House tonight; Ada Example is on my list.",
  },
};

export const OverTheLimit: Story = {
  args: {
    label: "Summary for the family",
    hint: "Keep it short. Families read this on their phones.",
    maxLength: 40,
    defaultValue: "Ada enjoyed the garden this afternoon and had tea with Ben.",
  },
};

export const WithError: Story = {
  args: {
    label: "Reason",
    hint: "At least 20 characters. It is recorded in the audit log with your name.",
    error: "Explain why you need this record in 20 characters or more.",
    maxLength: 1000,
    defaultValue: "Covering",
  },
};

export const Disabled: Story = {
  args: {
    label: "Original note",
    hint: "Notes cannot be changed. Add a correction instead.",
    defaultValue: "Ada had two carers for the morning visit.",
    disabled: true,
  },
};
