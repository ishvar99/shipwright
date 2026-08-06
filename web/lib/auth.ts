import { betterAuth } from "better-auth";

const clientId = process.env.GITHUB_CLIENT_ID ?? "";
const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";

/** Connect GitHub is configured, not assumed: the hosted demo has no OAuth app and must still
 * build and boot. Every surface checks this before offering to connect. */
export const githubConfigured = Boolean(clientId && clientSecret);

// The gate is only as strong as this secret: sessions are JWE cookies, so anyone holding the
// published dev fallback could mint one and walk through signedIn(). Refusing to boot beats
// silently running a forgeable gate. Without OAuth the gate is off and the fallback is fine.
if (githubConfigured && !process.env.BETTER_AUTH_SECRET) {
  throw new Error("Set BETTER_AUTH_SECRET when GitHub OAuth is configured — sessions are signed with it.");
}

/**
 * Stateless by design — this app has no database and wants none. Better Auth auto-enables
 * cookie sessions when no adapter is configured; `jwe` encrypts them, which matters because
 * the cookie carries a repo-scoped GitHub token.
 */
export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET ?? "shipwright-dev-secret-not-for-production-use",
  session: {
    cookieCache: { enabled: true, strategy: "jwe", maxAge: 60 * 60 * 24 },
  },
  account: {
    storeStateStrategy: "cookie",
    storeAccountCookie: true,
    // Known stateless-mode bug: updating on sign-in strips providerId and getAccessToken
    // then reports "Account Not Found".
    updateAccountOnSignIn: false,
  },
  socialProviders: githubConfigured
    ? {
        github: {
          clientId,
          clientSecret,
          // Classic OAuth apps have no read-only private scope; the UI discloses this.
          scope: ["repo"],
        },
      }
    : {},
});
