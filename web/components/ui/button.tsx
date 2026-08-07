import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
};

/** Hierarchy by fill, not border weight: one primary action per surface. */
export function Button({ className, variant = "secondary", ...props }: Props) {
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-[var(--radius)] px-4",
        "text-[length:var(--text-ui)] font-medium transition-[background-color,border-color,transform] duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-disabled:cursor-not-allowed aria-disabled:opacity-60",
        // A half-pixel of lift on the one filled action: alive, not bouncy. The global
        // :active press cancels it, so a click still lands.
        variant === "primary" &&
          "bg-ink text-ink-fg shadow-sm hover:-translate-y-px hover:bg-[var(--ink-hover)] active:translate-y-0",
        variant === "secondary" && "border border-hairline bg-surface text-fg shadow-sm hover:border-accent",
        variant === "ghost" && "bg-transparent text-muted hover:bg-soft hover:text-fg",
        className,
      )}
      {...props}
    />
  );
}
