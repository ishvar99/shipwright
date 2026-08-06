"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";

type Status = { configured: boolean; connected: boolean; login: string };

/** Who is signed in, visible where the eye already goes for nav. Renders nothing when auth
 * is unconfigured or signed out — the layout gate means signed-out never reaches this. */
export function AccountRow() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/api/github/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => {
        if (alive && s) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!status?.connected || !status.login) return null;

  const signOut = async () => {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
    // The layout re-checks the session, so a plain navigation is the whole flow.
    window.location.assign("/signin");
  };

  return (
    <div className="sw-account" title={status.login}>
      <span aria-hidden className="sw-account-mark">
        {status.login.slice(0, 1).toUpperCase()}
      </span>
      <span className="sw-rail-hide sw-truncate min-w-0 flex-1">{status.login}</span>
      <button
        type="button"
        onClick={() => void signOut()}
        aria-label="Sign out"
        title="Sign out"
        className="sw-account-out sw-rail-hide"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
