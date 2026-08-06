import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { WorkspaceFrame } from "@/components/workspace/workspace-frame";
import { WorkspaceProvider } from "@/components/workspace/workspace-provider";
import { signedIn } from "@/lib/owner";
import { UI_PREFS_BOOT } from "@/lib/ui-prefs";

export const metadata: Metadata = {
  title: "Workspace · Shipwright",
};

/**
 * The dense register is scoped to this segment, so the landing page keeps the expressive one and
 * the density cannot leak across a client-side navigation.
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  // The whole workspace is behind sign-in whenever GitHub OAuth is configured. Checked here,
  // not in middleware: a stateless JWE session needs the auth runtime to verify, and every
  // workspace route flows through this one layout anyway.
  if (!(await signedIn(await headers()))) redirect("/signin");
  return (
    <div className="register-dense">
      {/* Blocking, so restored pane widths and the sidebar state are in the first layout rather
          than a frame later. Same approach next-themes already uses here for the theme class. */}
      <script dangerouslySetInnerHTML={{ __html: UI_PREFS_BOOT }} />
      {/* Configuration decides provenance, not a runtime probe: a probe would treat a 503 as
          "use the recording", which would also silently mask a broken local backend. */}
      <WorkspaceProvider live={Boolean(process.env.BACKEND_URL)}>
        <WorkspaceFrame>{children}</WorkspaceFrame>
      </WorkspaceProvider>
    </div>
  );
}
