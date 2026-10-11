import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileClock, NotebookPen, ShieldCheck } from "lucide-react";
import { iconProps } from "../../lib/icon";
import { Timeline, type TimelineEntry } from "./Timeline";

const careNotes: TimelineEntry[] = [
  {
    id: "n-3",
    author: "Ben Sample",
    authorRole: "Senior carer",
    time: "2026-10-03T13:05:00Z",
    title: "Lunch",
    body: "Ada ate most of her lunch and drank two cups of tea. She enjoyed the music session.",
    icon: <NotebookPen {...iconProps} />,
  },
  {
    id: "n-2",
    author: "Dina Testcase",
    authorRole: "Carer",
    time: "2026-10-03T09:40:00Z",
    title: "Personal care",
    body: "Ada had a shower with help from one carer. Skin checked: no marks seen.",
    icon: <NotebookPen {...iconProps} />,
    correction: {
      body: "Ada had a shower with help from two carers. Skin checked: no marks seen.",
      author: "Dina Testcase",
      time: "2026-10-03T10:12:00Z",
      reason: "Wrong number of carers recorded",
    },
  },
  {
    id: "n-1",
    author: "Gita Mockup",
    authorRole: "Night carer",
    time: "2026-10-03T05:30:00Z",
    body: "Settled night. Checked every two hours; asleep each time.",
    icon: <NotebookPen {...iconProps} />,
  },
];

const auditHistory: TimelineEntry[] = [
  {
    id: "a-2",
    author: "Ben Sample",
    time: "2026-10-02T16:20:00Z",
    timeLabel: "02/10/2026 17:20",
    title: "Care plan reviewed",
    body: "Mobility section updated after the physiotherapy visit.",
    icon: <ShieldCheck {...iconProps} />,
  },
  {
    id: "a-1",
    author: "Harbour",
    time: "2026-10-01T08:00:00Z",
    timeLabel: "01/10/2026 09:00",
    title: "Record exported",
    body: "Exported for the CQC inspection by Clive Placeholder.",
    icon: <FileClock {...iconProps} />,
  },
];

const meta = {
  title: "Product shell/Timeline",
  component: Timeline,
  args: { entries: careNotes, label: "Care notes for Ada Example" },
} satisfies Meta<typeof Timeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CareNotes: Story = {};

export const AuditHistory: Story = {
  args: { entries: auditHistory, label: "Record history" },
};
