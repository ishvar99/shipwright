import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        // min-w-0: without it a wide child sets the panel's min-content width and overflows
        // whatever grid or flex row it sits in.
        "flex min-h-0 min-w-0 flex-col rounded-[var(--radius)] border border-hairline bg-soft",
        className,
      )}
    >
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
          <h2 className="truncate text-xs font-medium uppercase tracking-wide text-subtle">
            {title}
          </h2>
          {actions}
        </header>
      )}
      {/* Stable gutter: a scrollbar appearing later would narrow the content box and
          re-ellipsise every truncated row at once. */}
      <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">{children}</div>
    </section>
  );
}
