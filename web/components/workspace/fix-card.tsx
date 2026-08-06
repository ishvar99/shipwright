"use client";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { Fix } from "@/lib/contracts";
import { cn } from "@/lib/cn";
import { parseUnifiedDiff } from "@/lib/results/diff";

function download(patch: string, name: string) {
  const url = URL.createObjectURL(new Blob([patch], { type: "text/x-patch" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** The proposed change: streams as plain code while the engine writes, then settles into a
 * red/green diff once validated. Every action here is human-gated. */
export function FixCard({
  fix,
  fixText,
  writing,
  busy,
  pendingKind = null,
  live,
  onApply,
  onTest,
  onRetry,
  actions = true,
}: {
  fix: Fix | null | undefined;
  fixText: string;
  writing: boolean;
  busy: boolean;
  /** Which action is in flight, so the button says what it is doing. */
  pendingKind?: "apply" | "test" | "fix_retry" | null;
  live: boolean;
  onApply: () => void;
  onTest: () => void;
  onRetry: () => void;
  actions?: boolean;
}) {
  if (writing && !fix?.patch) {
    return (
      <div className="sw-card overflow-hidden">
        <p className="border-b border-hairline px-4 py-2 text-xs font-medium text-subtle">
          Draft — being written
        </p>
        <pre className="sw-fix-stream">{fixText || " "}</pre>
      </div>
    );
  }
  if (!fix?.patch) return null;

  const files = parseUnifiedDiff(fix.patch);
  const applied = Boolean(fix.applied_branch);
  const tests = fix.tests ?? null;
  // Replay only: the recorded demo advances by clicking these, and nothing on the screen said
  // so. A game-style pulse marks the next step; live runs stay quiet — a real apply is a
  // decision, not a beat to be nudged through.
  const nudge = !live && !busy;

  return (
    <div className="sw-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-2.5">
        <span className="font-medium text-fg">Proposed fix</span>
        <span className="font-mono text-xs text-subtle">
          <span className="text-ok">+{fix.additions ?? 0}</span>{" "}
          <span className="text-danger">−{fix.deletions ?? 0}</span>
        </span>
        {applied && (
          <span className="rounded-full bg-ok-soft px-2 py-0.5 font-mono text-xs text-ok">
            {fix.applied_branch}
          </span>
        )}
        {tests && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              tests.failed > 0 ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok",
            )}
          >
            {tests.failed > 0 ? `${tests.failed} test${tests.failed === 1 ? "" : "s"} failing` : `${tests.passed} tests passing`}
          </span>
        )}
      </div>

      {files.map((f) => (
        <div key={f.path}>
          <p className="border-b border-hairline bg-soft px-4 py-1.5 font-mono text-xs text-muted">
            {f.path}
          </p>
          <div className="overflow-x-auto">
            {f.hunks.map((h, i) => (
              <div key={i}>
                {i > 0 && (
                  <div aria-hidden className="sw-diff-gap">
                    ⋯
                  </div>
                )}
                <pre className="sw-diff">
                  {h.lines.map((l, j) => (
                    <div key={j} className={cn("sw-diff-line", `sw-diff-${l.kind}`)}>
                      <span aria-hidden className="sw-diff-sign">
                        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                      </span>
                      {l.text || " "}
                    </div>
                  ))}
                </pre>
              </div>
            ))}
          </div>
        </div>
      ))}

      {actions && (
      <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-3">
        {!applied && (
          <Button
            variant="primary"
            onClick={onApply}
            aria-disabled={busy || undefined}
            className={cn(nudge && "sw-tap-hint")}
          >
            <Icon name="check" size={16} />
            {pendingKind === "apply" ? "Applying…" : "Apply fix"}
          </Button>
        )}
        {applied && !tests && (
          <Button
            variant="primary"
            onClick={onTest}
            aria-disabled={busy || undefined}
            className={cn(nudge && "sw-tap-hint")}
          >
            {pendingKind === "test" ? "Running tests…" : "Run tests"}
          </Button>
        )}
        {tests && tests.failed > 0 && (fix.attempt ?? 1) < 2 && live && (
          <Button variant="primary" onClick={onRetry} aria-disabled={busy || undefined}>
            {pendingKind === "fix_retry" ? "Trying again…" : "Try again with the failure"}
          </Button>
        )}
        <Button variant="ghost" onClick={() => download(fix.patch!, "shipwright-fix.patch")}>
          Download .patch
        </Button>
      </div>
      )}
    </div>
  );
}
