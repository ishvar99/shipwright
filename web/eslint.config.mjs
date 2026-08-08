import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/** Kept minimal on purpose. The value here is the react-hooks rules, which catch stale
 * closures in the SSE subscriptions that tsc cannot see. */
// public/monaco is a verbatim copy of a vendored bundle, not our source.
const config = [
  { ignores: [".next/**", "node_modules/**", "public/monaco/**"] },
  ...coreWebVitals,
  ...typescript,
  {
    // The server-only boundary, enforced instead of merely commented. These modules hold the
    // grounding prompt, the backend's shared secret and the auth instance; one import of
    // lib/lite from a client component would publish the prompt in a static chunk with
    // nothing failing. `server-only` is the usual guard but it is a runtime dependency, and
    // lint is free.
    // Client-side code only. `app/**` is deliberately absent: layouts and route handlers
    // there are server components that legitimately hold the session (app/app/layout.tsx
    // gates on `signedIn`), and a rule that fires on correct code gets disabled.
    files: ["components/**/*.{ts,tsx}", "lib/client/**", "lib/local/**", "lib/stream/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/lite", message: "Server-only: holds the grounding prompt and provider config." },
            { name: "@/lib/backend", message: "Server-only: holds SHIPWRIGHT_API_KEY and the engine URL." },
            { name: "@/lib/auth", message: "Server-only: the better-auth instance and OAuth secrets." },
            { name: "@/lib/owner", message: "Server-only: resolves identity from the session cookie." },
          ],
        },
      ],
    },
  },
];

export default config;
