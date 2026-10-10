import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "soft";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-text hover:opacity-90 disabled:opacity-50",
  secondary: "bg-surface text-text border border-border hover:bg-surface-2 disabled:opacity-50",
  ghost: "text-text hover:bg-surface-2 disabled:opacity-40",
  danger: "bg-negative-strong text-white hover:opacity-90 disabled:opacity-50",
  soft: "bg-accent-soft text-accent hover:opacity-90 disabled:opacity-50",
};

const SIZES: Record<Size, string> = {
  sm: "h-10 px-3 text-sm gap-1.5 rounded-xl",
  md: "h-11 px-4 text-[15px] gap-2 rounded-xl",
  lg: "h-12 px-5 text-base gap-2 rounded-xl",
};

export function Button({
  variant = "primary",
  size = "md",
  icon,
  loading,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center font-medium transition select-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {loading ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />
      ) : icon ? (
        <Icon name={icon} size={size === "sm" ? 16 : 18} />
      ) : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = 40,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; variant?: Variant; size?: number }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition ${VARIANTS[variant]} ${className}`}
    >
      <Icon name={icon} size={Math.round(size * 0.48)} />
    </button>
  );
}
