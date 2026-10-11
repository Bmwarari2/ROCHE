import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusChip } from "./StatusChip";

const meta = {
  title: "Product shell/Status chip",
  component: StatusChip,
  args: { status: "overdue" },
} satisfies Meta<typeof StatusChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overdue: Story = {};

export const Due: Story = { args: { status: "due" } };

export const Done: Story = { args: { status: "done" } };

export const NotApplicable: Story = { args: { status: "notApplicable" } };

export const CustomLabel: Story = { args: { status: "due", label: "Due at 14:00" } };

export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <StatusChip status="overdue" />
      <StatusChip status="due" />
      <StatusChip status="done" />
      <StatusChip status="notApplicable" />
      <StatusChip status="info" label="New" />
      <StatusChip status="neutral" label="Draft" />
    </div>
  ),
};
