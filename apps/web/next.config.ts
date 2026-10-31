import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Harbour web (master prompt section 6). The browser talks to one origin: Better Auth calls are
 * passed to the API by `src/app/api/auth/[...path]/route.ts`, and pages fetch the API on the
 * server, so the session cookie stays first-party and no cross-origin requests are needed. The
 * API's address (API_URL, or API_BASE_URL as Terraform names it) is read when the server starts,
 * so one image serves every environment. The web tier never opens a database connection.
 */

// The Content Security Policy carries a per-request nonce, so it is set in src/proxy.ts.

/** Browser features the product shell never uses are switched off; passkeys stay on for this origin. */
const permissionsPolicy = [
  "accelerometer=()",
  "autoplay=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "usb=()",
  "publickey-credentials-create=(self)",
  "publickey-credentials-get=(self)",
].join(", ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: permissionsPolicy },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  // A self-contained server bundle for the container image; tracing starts at the monorepo root so
  // the workspace packages are included.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // No next/image optimisation: photos are personal data served through our own route, and the
  // optional sharp dependency (LGPL libvips) is not needed.
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  // Organisation documents are uploaded through a server action (PLAT-009): its body limit matches
  // the API's largest document category (25 MB) with room for the form; the API applies each
  // category's own limit again and refuses anything larger.
  experimental: { serverActions: { bodySizeLimit: "26mb" } },
  transpilePackages: ["@harbour/ui", "@harbour/contracts", "@harbour/i18n", "@harbour/domain"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The invitation page sends no Referer at all (platform.md, #43 review M1); a later rule wins.
      { source: "/invitation", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
