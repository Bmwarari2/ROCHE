import type { Meta, StoryObj } from "@storybook/react-vite";
import { Plus } from "lucide-react";
import { iconProps } from "../../lib/icon";
import { Button } from "../Button/Button";
import { StatusChip } from "../StatusChip/StatusChip";
import { PageHeader } from "./PageHeader";

const meta = {
  title: "Product shell/Page header",
  component: PageHeader,
  args: {
    eyebrow: "People",
    title: "Ada Example",
    description: "Room 12, Rowan House. Prefers to be called Ada.",
    primaryAction: <Button icon={<Plus {...iconProps} />}>Add care note</Button>,
  },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithSecondaryActions: Story = {
  args: {
    secondaryActions: (
      <>
        <Button variant="tertiary">View history</Button>
        <Button variant="secondary">Print record</Button>
      </>
    ),
    children: (
      <>
        <StatusChip status="due" label="Review due 14/10/2026" />
        <StatusChip status="info" label="Large print" />
      </>
    ),
  },
};

export const TitleOnly: Story = {
  args: {
    eyebrow: undefined,
    title: "Rota",
    description: undefined,
    primaryAction: undefined,
  },
};
