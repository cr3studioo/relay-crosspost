"use client";
import { useFormStatus } from "react-dom";
export function Submit({
  children,
  className = "button",
  disabled = false,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className} disabled={disabled || pending} type="submit">
      {pending ? "Working…" : children}
    </button>
  );
}
