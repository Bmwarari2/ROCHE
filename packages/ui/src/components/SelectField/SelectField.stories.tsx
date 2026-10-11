import type { Meta, StoryObj } from "@storybook/react-vite";
import { SelectField } from "./SelectField";

const meta = {
  title: "Primitives/Select field",
  component: SelectField,
  args: {
    label: "Meal",
    emptyOption: "Choose a meal",
    options: [
      { value: "breakfast", label: "Breakfast" },
      { value: "lunch", label: "Lunch" },
      { value: "dinner", label: "Dinner" },
      { value: "snack", label: "Snack" },
    ],
  },
} satisfies Meta<typeof SelectField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithHint: Story = {
  args: {
    label: "IDDSI food level given",
    hint: "Prescribed: Level 5 Minced and moist (orange)",
    emptyOption: undefined,
    defaultValue: "5",
    options: [
      { value: "4", label: "Level 4 Pureed (green)" },
      { value: "5", label: "Level 5 Minced and moist (orange)" },
      { value: "6", label: "Level 6 Soft and bite-sized (blue)" },
    ],
  },
};

export const WithGroups: Story = {
  args: {
    label: "Body area, as marked on the drawing",
    emptyOption: "Choose a body area",
    options: [],
    groups: [
      {
        label: "Knee",
        options: [
          { value: "knee:left", label: "Knee, the person's left" },
          { value: "knee:right", label: "Knee, the person's right" },
        ],
      },
      {
        label: "Chest",
        options: [
          { value: "chest:left", label: "Chest, the person's left" },
          { value: "chest:midline", label: "Chest, midline" },
          { value: "chest:right", label: "Chest, the person's right" },
        ],
      },
    ],
  },
};

export const WithError: Story = { args: { error: "Choose a meal" } };
