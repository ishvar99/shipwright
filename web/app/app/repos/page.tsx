"use client";

import { useRouter } from "next/navigation";
import { RepositoriesView } from "@/components/workspace/repositories-view";
import { useWorkspace } from "@/components/workspace/workspace-provider";

export default function Page() {
  const { live, repos, repoList, selectRepo } = useWorkspace();
  const router = useRouter();
  return (
    <RepositoriesView
      state={{ ...repos, repos: repoList }}
      demo={!live}
      onOpenRepo={(r) => router.push(`/app/repo/${r.id}`)}
      onStartSession={(r) => {
        selectRepo(r);
        router.push("/app");
      }}
    />
  );
}
