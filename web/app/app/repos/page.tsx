"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RepositoriesView } from "@/components/workspace/repositories-view";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { importLocalGitHub, importLocalZip } from "@/lib/local/import";
import { repoHome } from "@/lib/repo-routes";

export default function Page() {
  const { live, liteMode, repos, repoList, sessionsFor, selectRepo, refreshLocal, unlinkRepo } =
    useWorkspace();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // With no backend the same form imports into this browser instead. Offered whenever the
  // engine is unreachable, which is exactly when the server-side path would fail anyway.
  const offline = !live || liteMode;

  const runImport = (work: () => Promise<{ id: string }>) => {
    setBusy("Starting…");
    setError(null);
    void work()
      .then((repo) => {
        refreshLocal();
        router.push(repoHome(repo.id));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "That import failed."))
      .finally(() => setBusy(null));
  };

  return (
    <RepositoriesView
      state={{ ...repos, repos: repoList }}
      demo={!live && !offline}
      local={
        offline
          ? {
              busy,
              error,
              importZip: (file) => runImport(() => importLocalZip(file, setBusy)),
              importUrl: (url) => runImport(() => importLocalGitHub(url, setBusy)),
            }
          : undefined
      }
      onOpenRepo={(r) => {
        selectRepo(r);
        router.push(repoHome(r.id));
      }}
      sessionCount={(id) => sessionsFor(id).length}
      onUnlinkRepo={(r) => void unlinkRepo(r.id)}
    />
  );
}
