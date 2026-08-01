import type { NextConfig } from "next";

/**
 * Content-Security-Policy.
 *
 * `script-src` carries 'unsafe-inline', and that is a stated limitation rather than an
 * oversight. Every page here is statically prerendered, so there is no per-request nonce to
 * issue; and Next emits a dozen inline bootstrap scripts per page (the React payload, plus
 * next-themes' and the pane-prefs before-paint scripts) whose contents change on every build,
 * so hashing them is not maintainable. A nonce would mean giving up static prerendering on a
 * site whose entire deployment story is "static, no backend".
 *
 * So this policy does NOT mitigate injected-inline XSS. What it does block is the threat this
 * site actually has: script or style from any other origin, plugin content, framing, and
 * base-tag hijacking. Worth having even without a strict script-src.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  // Tailwind and React both emit inline styles; there is no external stylesheet origin.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // next/font self-hosts Geist, so no Google Fonts origin is needed; data: is for Monaco
  // 0.56, which embeds the codicon font as a data URI inside editor.main.css.
  "font-src 'self' data:",
  // Monaco's min build bootstraps its worker through a blob that importScripts() a
  // same-origin asset. Without blob: the editor silently falls back to the main thread.
  "worker-src 'self' blob:",
  "connect-src 'self'", // the SSE stream and every fetch are same-origin through the BFF
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Redundant with frame-ancestors, kept for user agents predating CSP 2.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
