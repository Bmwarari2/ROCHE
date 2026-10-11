import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  CalendarDays,
  ChartColumn,
  House,
  NotebookPen,
  Pill,
  Settings,
  TriangleAlert,
  Users,
} from "lucide-react";
import { iconProps } from "../../lib/icon";
import { Sidebar, type SidebarItem } from "./Sidebar";

const items: SidebarItem[] = [
  { id: "home", label: "Home", href: "#home", icon: <House {...iconProps} /> },
  { id: "people", label: "People", href: "#people", icon: <Users {...iconProps} /> },
  { id: "notes", label: "Care notes", href: "#notes", icon: <NotebookPen {...iconProps} /> },
  {
    id: "medicines",
    label: "Medicines",
    href: "#medicines",
    icon: <Pill {...iconProps} />,
    badge: "2",
    badgeLabel: "2 overdue",
  },
  { id: "rota", label: "Rota", href: "#rota", icon: <CalendarDays {...iconProps} /> },
  {
    id: "incidents",
    label: "Incidents",
    href: "#incidents",
    icon: <TriangleAlert {...iconProps} />,
  },
  { id: "reports", label: "Reports", href: "#reports", icon: <ChartColumn {...iconProps} /> },
  { id: "settings", label: "Settings", href: "#settings", icon: <Settings {...iconProps} /> },
];

const meta = {
  title: "Product shell/Sidebar",
  component: Sidebar,
  args: { items, currentId: "people" },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: 640 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};

export const Collapsed: Story = {
  args: { defaultCollapsed: true, currentId: "medicines" },
};
