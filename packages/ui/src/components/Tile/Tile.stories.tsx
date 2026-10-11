import type { Meta, StoryObj } from "@storybook/react-vite";
import { CalendarDays, Pill, TriangleAlert } from "lucide-react";
import { iconProps } from "../../lib/icon";
import { StatusChip } from "../StatusChip/StatusChip";
import { Tile } from "./Tile";

const meta = {
  title: "Product shell/Tile",
  component: Tile,
  args: {
    title: "Medicines due",
    value: "12",
    description: "Lunchtime round, Rowan House",
    icon: <Pill {...iconProps} />,
    link: { href: "#medicines", label: "Open the medicines round" },
  },
} satisfies Meta<typeof Tile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Metric: Story = {};

export const WithStatus: Story = {
  args: {
    title: "Overdue medicines",
    value: "2",
    status: <StatusChip status="overdue" label="2 overdue" />,
    description: "Ada Example and Hilda Fixture",
    link: { href: "#medicines-overdue", label: "Review overdue medicines" },
  },
};

export const Dashboard: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gap: 16,
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
      }}
    >
      <Tile
        title="Medicines due"
        value="12"
        icon={<Pill {...iconProps} />}
        link={{ href: "#medicines", label: "Open the medicines round" }}
      />
      <Tile
        title="Open incidents"
        value="3"
        icon={<TriangleAlert {...iconProps} />}
        status={<StatusChip status="due" label="1 needs review" />}
        link={{ href: "#incidents", label: "Review incidents" }}
      />
      <Tile
        title="Shifts to fill"
        value="1"
        icon={<CalendarDays {...iconProps} />}
        description="Night shift on 14/10/2026"
        link={{ href: "#rota", label: "Open the rota" }}
      />
    </div>
  ),
};
