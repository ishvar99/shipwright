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
        "flex min-h-0 flex-col rounded-[var(--radius)] border border-hairline bg-soft",
        className,
      )}
    >
      {title && (
        <header className="flex items-center justify-between border-b border-hairline px-3 py-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-subtle">{title}</h2>
          {actions}
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}
