"use client";

import { useRouter } from "next/navigation";
import { RepositoriesView } from "@/components/workspace/repositories-view";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { repoHome } from "@/lib/repo-routes";

export default function Page() {
  const { live, repos, repoList, selectRepo } = useWorkspace();
  const router = useRouter();
  return (
    <RepositoriesView
      state={{ ...repos, repos: repoList }}
      demo={!live}
      onOpenRepo={(r) => {
        selectRepo(r);
        router.push(repoHome(r.id));
      }}
    />
  );
}
