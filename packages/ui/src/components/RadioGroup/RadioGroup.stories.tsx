import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { RadioGroup } from "./RadioGroup";

const sides = [
  { value: "left", label: "Left", description: "The person's own left" },
  { value: "right", label: "Right", description: "The person's own right" },
  { value: "midline", label: "Midline" },
] as const;

const meta = {
  title: "Primitives/Radio group",
  component: RadioGroup,
  args: {
    legend: "Which side of the person's body?",
    hint: "Choose in words as well as on the drawing.",
    name: "side",
    options: sides,
  },
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Stacked: Story = {};

export const Inline: Story = {
  args: {
    legend: "Air or oxygen",
    hint: undefined,
    name: "oxygen",
    layout: "inline",
    options: [
      { value: "air", label: "Air" },
      { value: "oxygen", label: "Oxygen" },
    ],
    defaultValue: "air",
  },
};

export const GridWithDescriptions: Story = {
  args: {
    legend: "Bristol stool chart",
    hint: undefined,
    name: "bristol",
    layout: "grid",
    options: [
      { value: "1", label: "Type 1", description: "Separate hard lumps" },
      { value: "2", label: "Type 2", description: "Lumpy and sausage-like" },
      { value: "3", label: "Type 3", description: "Sausage shape with cracks" },
      { value: "4", label: "Type 4", description: "Smooth, soft sausage or snake" },
    ],
  },
};

export const WithError: Story = {
  args: { error: "Choose the side in words" },
};

export const WithDisabledOption: Story = {
  args: {
    options: [
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
      { value: "midline", label: "Midline", disabled: true },
    ],
  },
};

function ControlledGroup() {
  const [value, setValue] = useState<"person" | "representative" | "unable" | null>(null);
  return (
    <RadioGroup
      legend="Who agreed the plan?"
      name="agreed"
      value={value}
      onValueChange={setValue}
      options={[
        { value: "person", label: "Ada agreed the plan" },
        { value: "representative", label: "A representative agreed it for Ada" },
        { value: "unable", label: "No one could agree it" },
      ]}
    />
  );
}

export const Controlled: Story = { render: () => <ControlledGroup /> };
