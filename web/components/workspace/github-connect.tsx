"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useGitHub } from "@/lib/client/use-github";
import { relativeTime } from "@/lib/sessions";

/** Connect GitHub, then pick a repository. Hidden entirely when no OAuth app is configured,
 * so a deployment without one never advertises a button that cannot work. */
export function GitHubConnect({
  live,
  onImport,
  importing,
}: {
  live: boolean;
  onImport: (input: { url: string; private: boolean }) => void;
  importing: boolean;
}) {
  const { status, repos, error, loading, loadRepos } = useGitHub(live);
  const [filter, setFilter] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  // Better Auth speaks JSON only; it answers with the URL to send the browser to, and the
  // OAuth handshake itself is a normal top-level navigation to github.com.
  const connect = async () => {
    setAuthError(null);
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
      setAuthError("Couldn't start the GitHub sign-in. Check the OAuth app settings.");
    }
  };

  const disconnect = async () => {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    window.location.reload();
  };

  if (!live || !status.configured) return null;

  if (!status.connected) {
    return (
      <div className="sw-card grid gap-3 p-5">
        <p className="font-medium text-fg">Import from your GitHub account</p>
        <p className="text-subtle">
          Connect to browse and import your repositories, including private ones. GitHub&rsquo;s
          classic OAuth scope grants read and write to all your repositories — you can revoke
          it at any time in{" "}
          <a
            href="https://github.com/settings/applications"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4 hover:text-fg"
          >
            your GitHub settings
          </a>
          .
        </p>
        <div className="grid gap-2">
          <div>
            <Button variant="primary" onClick={() => void connect()}>
              <Icon name="folder" size={16} />
              Connect GitHub
            </Button>
          </div>
          {authError && (
            <p role="alert" className="text-danger">
              {authError}
            </p>
          )}
        </div>
      </div>
    );
  }

  const shown = (repos ?? []).filter((r) =>
    r.full_name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="sw-card grid gap-3 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-medium text-fg">
          Connected{status.login ? ` as ${status.login}` : ""}
        </p>
        <Button onClick={() => void disconnect()} className="ml-auto h-7 px-2">
          Disconnect
        </Button>
      </div>

      {!repos && (
        <div>
          <Button onClick={() => void loadRepos()} aria-disabled={loading || undefined}>
            {loading ? "Loading…" : "Choose a repository"}
          </Button>
        </div>
      )}

      {(error || authError) && (
        <p role="alert" className="text-danger">
          {error ?? authError}
        </p>
      )}

      {repos && (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter repositories"
            aria-label="Filter repositories"
            className="sw-input"
          />
          <ul className="grid max-h-72 gap-1 overflow-y-auto">
            {!shown.length && <li className="text-subtle">No repository matches that.</li>}
            {shown.map((r) => (
              <li key={r.full_name} className="flex items-center gap-3 rounded-[var(--radius)] px-2 py-1.5 hover:bg-soft">
                <span className="min-w-0 flex-1 truncate text-fg">{r.full_name}</span>
                {r.private && (
                  <span className="shrink-0 rounded-full bg-soft px-1.5 text-xs text-subtle">
                    Private
                  </span>
                )}
                <span className="shrink-0 text-xs text-subtle">{relativeTime(r.updated_at)}</span>
                <Button
                  className="h-7 shrink-0 px-2"
                  aria-disabled={importing || undefined}
                  onClick={() =>
                    onImport({ url: `https://github.com/${r.full_name}`, private: r.private })
                  }
                >
                  Import
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
