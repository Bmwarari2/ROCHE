import type { Meta, StoryObj } from "@storybook/react-vite";
import { History, PencilLine } from "lucide-react";
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

/** Something that must be recorded and is not: a question mark and the words, never blank. */
export const NotRecorded: Story = { args: { status: "notRecorded" } };

/** Linked to the action that records it, so the warning is one step from being resolved. */
export const NotRecordedWithAction: Story = {
  args: {
    status: "notRecorded",
    label: "Allergies not recorded",
    href: "/people/example/allergies",
    actionLabel: "record them",
  },
};

export const CustomLabel: Story = { args: { status: "due", label: "Due at 14:00" } };

export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <StatusChip status="overdue" />
      <StatusChip status="due" />
      <StatusChip status="done" />
      <StatusChip status="notApplicable" />
      <StatusChip status="notRecorded" />
      <StatusChip status="info" label="New" />
      <StatusChip status="neutral" label="Draft" />
    </div>
  ),
};

/** States with their own symbol, for example care plan versions: always the icon and the word. */
export const CustomIcons: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <StatusChip status="info" label="Draft, not in use" icon={PencilLine} />
      <StatusChip status="neutral" label="Superseded" icon={History} />
    </div>
  ),
};
