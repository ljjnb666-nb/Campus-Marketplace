"use client";

import { signOut } from "next-auth/react";

export function SignOutButton({
  className,
  children = "退出",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className={className}
    >
      {children}
    </button>
  );
}
