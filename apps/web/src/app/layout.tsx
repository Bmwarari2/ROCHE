import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: t("app.name"), template: `%s | ${t("app.name")}` },
  description: t("app.description"),
  applicationName: t("app.name"),
  // Personal data lives behind sign-in; nothing here is for search engines.
  robots: { index: false, follow: false },
  referrer: "same-origin",
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang={t.locale}>
      <body className="bg-bg-secondary">{children}</body>
    </html>
  );
}
