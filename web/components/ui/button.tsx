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
        "text-[length:var(--text-ui)] font-medium transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-disabled:cursor-not-allowed aria-disabled:opacity-60",
        variant === "primary" && "bg-accent text-bg shadow-sm hover:bg-[var(--accent-hover)]",
        variant === "secondary" && "border border-hairline bg-surface text-fg shadow-sm hover:border-accent",
        variant === "ghost" && "bg-transparent text-muted hover:bg-soft hover:text-fg",
        className,
      )}
      {...props}
    />
  );
}
