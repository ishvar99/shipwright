import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/** Kept minimal on purpose. The value here is the react-hooks rules, which catch stale
 * closures in the SSE subscriptions that tsc cannot see. */
// public/monaco is a verbatim copy of a vendored bundle, not our source.
const config = [
  { ignores: [".next/**", "node_modules/**", "public/monaco/**"] },
  ...coreWebVitals,
  ...typescript,
];

export default config;
