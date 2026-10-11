import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClipboardList, HeartPulse, NotebookPen } from "lucide-react";
import { iconProps } from "../../lib/icon";
import { TabNav } from "./TabNav";

const sections = [
  { href: "#overview", label: "Overview" },
  { href: "#care-plan", label: "Care plan" },
  { href: "#assessments", label: "Assessments" },
  { href: "#risk", label: "Risk assessments" },
  { href: "#notes", label: "Notes", current: true },
  { href: "#charts", label: "Charts" },
  { href: "#body-map", label: "Body map" },
  { href: "#advance-care", label: "Advance care" },
  { href: "#activities", label: "Activities and visits" },
  { href: "#history", label: "History" },
];

const meta = {
  title: "Product shell/Tab navigation",
  component: TabNav,
  args: { label: "Sections of Ada Example's record", items: sections },
} satisfies Meta<typeof TabNav>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RecordSections: Story = {};

export const WithIcons: Story = {
  args: {
    label: "Charts to record",
    items: [
      { href: "#notes", label: "Notes", icon: <NotebookPen {...iconProps} /> },
      { href: "#plan", label: "Care plan", icon: <ClipboardList {...iconProps} />, current: true },
      { href: "#vitals", label: "Vital signs", icon: <HeartPulse {...iconProps} /> },
    ],
  },
};

/** On a phone the row scrolls sideways on its own; the page never does. */
export const NarrowScreen: Story = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 320 }}>
        <Story />
      </div>
    ),
  ],
};
