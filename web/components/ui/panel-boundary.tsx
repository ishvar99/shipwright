"use client";

import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Props = { label: string; children: ReactNode };
type State = { error: Error | null };

/**
 * Per-panel, not per-route. A route-level error.tsx would replace the whole workspace, losing
 * the trace and the results because the code pane threw — so each pane contains its own
 * failure and keeps its neighbours alive.
 *
 * A class component because React exposes no hook for this; there is no functional equivalent.
 */
export class PanelBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // No reporting service on a $0 deployment; the console is the whole story.
    console.error("panel crashed", this.props.label, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-start justify-center gap-2 p-6" role="alert">
        <p className="text-fg">The {this.props.label} panel stopped working.</p>
        <p className="max-w-[36ch] text-subtle">
          The rest of the workspace is unaffected. {error.message}
        </p>
        {/* One recovery action, per the state rules — and it retries this panel only. */}
        <Button onClick={() => this.setState({ error: null })}>Reload this panel</Button>
      </div>
    );
  }
}
