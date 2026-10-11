import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../Button/Button";
import { StatusChip } from "../StatusChip/StatusChip";
import { InspectorPanel } from "./InspectorPanel";

const details = (
  <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 16px", margin: 0 }}>
    <dt>Preferred name</dt>
    <dd style={{ margin: 0 }}>Ada</dd>
    <dt>Room</dt>
    <dd style={{ margin: 0 }}>12</dd>
    <dt>NHS number</dt>
    <dd style={{ margin: 0 }}>999 000 0018</dd>
    <dt>Key worker</dt>
    <dd style={{ margin: 0 }}>Ben Sample</dd>
    <dt>Medicines</dt>
    <dd style={{ margin: 0 }}>
      <StatusChip status="overdue" label="08:00 overdue" />
    </dd>
  </dl>
);

const meta = {
  title: "Product shell/Inspector panel",
  component: InspectorPanel,
  args: {
    title: "Ada Example",
    subtitle: "Room 12, Rowan House",
    onClose: () => {},
    children: details,
  },
} satisfies Meta<typeof InspectorPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithFooter: Story = {
  args: {
    footer: (
      <>
        <Button variant="secondary">Open record</Button>
        <Button>Record medicines</Button>
      </>
    ),
  },
};

export const WithoutClose: Story = {
  args: { onClose: undefined },
};
