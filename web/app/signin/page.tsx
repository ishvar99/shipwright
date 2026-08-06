import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SigninCard } from "@/components/auth/signin-card";
import { githubConfigured } from "@/lib/auth";
import { signedIn } from "@/lib/owner";

export const metadata: Metadata = {
  title: "Sign in · Shipwright",
};

/** Public. The workspace layout sends the signed-out here; the signed-in bounce straight
 * back so a stale bookmark never shows a sign-in form to someone with a session. */
export default async function Page() {
  if (githubConfigured && (await signedIn(await headers()))) redirect("/app");
  return <SigninCard configured={githubConfigured} />;
}
