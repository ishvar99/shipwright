import type { Metadata } from "next";
import { UI_PREFS_BOOT } from "@/lib/ui-prefs";

export const metadata: Metadata = {
  title: "Workspace · Shipwright",
};

/**
 * The dense register is scoped to this segment, so the landing page keeps the expressive one and
 * the density cannot leak across a client-side navigation.
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="register-dense">
      {/* Blocking, so restored pane widths are in the first layout rather than a frame later.
          Same approach next-themes already uses here for the theme class. */}
      <script dangerouslySetInnerHTML={{ __html: UI_PREFS_BOOT }} />
      {children}
    </div>
  );
}
