import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../Button/Button";
import { StatusChip } from "../StatusChip/StatusChip";
import { Card } from "./Card";

const meta = {
  title: "Product shell/Card",
  component: Card,
  args: {
    title: "Today's handover",
    description: "Morning shift, Rowan House",
    children: (
      <p style={{ margin: 0 }}>
        Ada Example slept well and had breakfast in the lounge. Clive Placeholder has a GP visit at
        11:30.
      </p>
    ),
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AsSectionWithActions: Story = {
  args: {
    as: "section",
    title: "Medicines",
    description: "Next round at 12:30",
    actions: <Button variant="tertiary">View chart</Button>,
    children: (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <StatusChip status="done" label="08:00 given" />
        <StatusChip status="due" label="12:30 due" />
      </div>
    ),
  },
};

export const WithFooter: Story = {
  args: {
    footer: (
      <>
        <Button variant="secondary">Edit</Button>
        <Button>Sign off</Button>
      </>
    ),
  },
};
