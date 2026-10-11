import type { Meta, StoryObj } from "@storybook/react-vite";
import { Plus, Trash2, X } from "lucide-react";
import { iconProps } from "../../lib/icon";
import { Button, ButtonLink, IconButton } from "./Button";

const meta = {
  title: "Primitives/Button",
  component: Button,
  args: {
    children: "Add care note",
    variant: "primary",
  },
  argTypes: {
    variant: {
      control: "inline-radio",
      options: ["primary", "secondary", "tertiary", "destructive"],
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Secondary: Story = {
  args: { variant: "secondary", children: "Save as draft" },
};

export const Tertiary: Story = {
  args: { variant: "tertiary", children: "View all care notes" },
};

export const Destructive: Story = {
  args: {
    variant: "destructive",
    children: "Remove Ben Sample from this shift",
    icon: <Trash2 {...iconProps} />,
  },
};

export const WithIcon: Story = {
  args: { icon: <Plus {...iconProps} />, children: "Add a person" },
};

export const Disabled: Story = {
  args: { disabled: true, children: "Submit" },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      <Button>Save</Button>
      <Button variant="secondary">Cancel</Button>
      <Button variant="tertiary">Learn more</Button>
      <Button variant="destructive">Delete draft</Button>
      <ButtonLink href="#people" variant="secondary">
        Go to people
      </ButtonLink>
      <IconButton label="Close" icon={<X {...iconProps} size={20} />} />
    </div>
  ),
};
