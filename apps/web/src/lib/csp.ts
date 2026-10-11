/**
 * Content Security Policy (ASVS 5.0 V3.4). Scripts run only with this request's nonce
 * ('strict-dynamic' lets Next.js's own chunks load the rest); same-origin everything else, no
 * third-party scripts, fonts or analytics. React needs eval only in development. Styles allow
 * inline attributes because Radix positions menus and tooltips with style attributes. Pure, unit
 * tested; applied per request by `src/proxy.ts`.
 */
export function contentSecurityPolicy(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "media-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** A fresh, unguessable nonce for one response (128 bits, base64). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
