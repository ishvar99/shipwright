import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet";
};

export function Button({ className, variant = "quiet", ...props }: Props) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5",
        "text-[length:var(--text-ui)] transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary"
          ? "border-transparent bg-accent text-bg hover:opacity-90"
          : "border-hairline bg-soft text-fg hover:border-accent",
        className,
      )}
      {...props}
    />
  );
}
