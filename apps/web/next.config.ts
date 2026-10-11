import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Harbour web (master prompt section 6). The browser talks to one origin: Better Auth and the
 * versioned API are proxied through this app, so the session cookie stays first-party and no
 * cross-origin requests are needed. The web tier never opens a database connection.
 *
 * Rewrites are resolved when the app is built, so API_URL (or API_BASE_URL, the name the
 * Terraform stack sets) must be present at build time as well as at run time.
 */
const apiUrl = (process.env.API_URL ?? process.env.API_BASE_URL ?? "http://localhost:4000").replace(
  /\/+$/,
  "",
);

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
  transpilePackages: ["@harbour/ui", "@harbour/contracts", "@harbour/i18n"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Only Better Auth and the versioned API are proxied; /api/health is answered by this app.
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${apiUrl}/api/auth/:path*` },
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
    ];
  },
};

export default nextConfig;
