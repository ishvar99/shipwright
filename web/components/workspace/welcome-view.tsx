import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { Logo } from "@/components/ui/logo";
import { demoJob, demoRepo } from "@/lib/fixtures";
import { repoSession } from "@/lib/repo-routes";

/** The launcher when nothing is imported. One action, one escape hatch — the guided replay
 * is how the recorded run earns its keep now that it lives in no list. */
export function WelcomeView() {
  return (
    <div className="sw-welcome">
      <Logo size={30} className="text-accent" />
      <h2 className="sw-welcome-head">Point Shipwright at a repository.</h2>
      <p className="sw-welcome-sub">
        It indexes the code, answers questions about it, and finds the lines behind any bug
        you describe.
      </p>
      <Link href="/app/repos" className="sw-primary-link">
        <Icon name="plus" size={16} />
        Import your repository
      </Link>
      <p className="text-subtle">
        or{" "}
        <Link href={`${repoSession(demoRepo.id, demoJob.id)}?tour=1`} className="sw-welcome-tour">
          watch Shipwright find a real bug first — 30 seconds
        </Link>
      </p>
    </div>
  );
}
