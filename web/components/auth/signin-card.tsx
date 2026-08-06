"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/** One provider, one button. The page around it stays out of the way: sign-in is a toll
 * booth, not a destination. */
export function SigninCard({ configured }: { configured: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Better Auth speaks JSON only; it answers with the URL to send the browser to, and the
  // OAuth handshake itself is a normal top-level navigation to github.com.
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/app" }),
      });
      const body: unknown = await res.json();
      const url = body && typeof body === "object" && "url" in body ? String(body.url) : "";
      if (!res.ok || !url) throw new Error("no redirect");
      window.location.href = url;
    } catch {
      setError("Couldn't start the GitHub sign-in. Try again in a moment.");
      setBusy(false);
    }
  };

  return (
    <main className="sw-signin">
      <div className="sw-signin-card">
        <p className="flex items-center gap-2 font-semibold text-fg">
          <Icon name="crosshair" size={18} className="text-accent" />
          Shipwright
        </p>
        {configured ? (
          <>
            <p className="text-muted">
              Sign in to open your workspace — your repositories and sessions are yours alone.
            </p>
            <Button variant="primary" onClick={() => void signIn()} aria-disabled={busy || undefined}>
              <Icon name="github" size={16} />
              {busy ? "Opening GitHub…" : "Continue with GitHub"}
            </Button>
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            {/* No OAuth app means the gate is off — this page only exists via old links. */}
            <p className="text-muted">
              Sign-in isn&apos;t configured on this deployment, so the workspace is open.
            </p>
            <Link href="/app" className="sw-primary-link">
              Open the workspace
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
