import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { LogOut, ShieldCheck } from "lucide-react";
import { iconProps } from "../../lib/icon";
import { AccountMenu, type AccountMenuItem } from "./AccountMenu";

const items: AccountMenuItem[] = [
  {
    id: "security",
    label: "Sign-in and security",
    href: "#security",
    icon: <ShieldCheck {...iconProps} size={16} />,
  },
  {
    id: "sign-out",
    label: "Sign out",
    icon: <LogOut {...iconProps} size={16} />,
    onSelect: () => {},
  },
];

/** Places the menu at the end of a bar, as the app bar does, so it opens towards the page. */
const inBar: Decorator = (Story) => (
  <div style={{ display: "flex", justifyContent: "flex-end", minHeight: 280 }}>
    <Story />
  </div>
);

const meta = {
  title: "Product shell/Account menu",
  component: AccountMenu,
  decorators: [inBar],
  args: {
    userName: "Ben Sample",
    userDetail: "ben.sample@example.invalid",
    organisationName: "Harbour Example Care",
    locationName: "Rowan House",
    items,
  },
} satisfies Meta<typeof AccountMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * An open menu is portalled to the end of the page, outside every landmark, and hides the rest of
 * the page from assistive technology while focus is inside it. That is how a menu works, so the
 * best-practice "region" rule (all content inside landmarks) is off for the open stories only.
 */
const openMenu = {
  a11y: { options: { rules: { region: { enabled: false } } } },
};

export const Closed: Story = {};

export const Open: Story = {
  args: { defaultOpen: true },
  parameters: openMenu,
};

export const AllLocations: Story = {
  args: { defaultOpen: true, locationName: "All locations" },
  parameters: openMenu,
};

export const SigningOut: Story = {
  args: {
    defaultOpen: true,
    items: items.map((item) => (item.id === "sign-out" ? { ...item, disabled: true } : item)),
  },
  parameters: openMenu,
};
