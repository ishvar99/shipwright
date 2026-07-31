import { WorkspaceShell } from "@/components/workspace/shell";

/**
 * Configuration decides provenance, not a runtime probe. A probe would treat a 503 as "use the
 * recording", which would also silently mask a genuinely broken local backend.
 */
export default function WorkspacePage() {
  return <WorkspaceShell live={Boolean(process.env.BACKEND_URL)} />;
}
