import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Harbour", template: "%s | Harbour" },
  description: "Harbour care platform",
  applicationName: "Harbour",
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
    <html lang="en-GB">
      <body className="bg-bg-secondary">{children}</body>
    </html>
  );
}
