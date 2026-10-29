import type { Metadata } from "next";
import Link from "next/link";

import { RestrictedAppealPortal } from "@/components/appeals/restricted-appeal-portal";

export const metadata: Metadata = {
  title: "账号申诉 | 校园集市",
};

/**
 * Public shell only. No private DB data or authenticated SSR hydration here.
 * The client fetches exclusively through the established appeal-specific
 * ACTIVE|SUSPENDED DB-refreshed API allowlist, never through requireUser().
 */
export default function AppealsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <Link href="/login" className="text-sm text-slate-600 underline">
        返回登录
      </Link>
      <h1 className="mt-6 text-3xl font-semibold text-slate-950">账号与处罚申诉</h1>
      <p className="mt-3 text-sm leading-7 text-slate-600">
        已登录用户可查询与本人相关的可申诉处罚并提交说明。账号受到限制时，
        此入口不恢复账号权限，也不会开放普通通知、订单或其他私人业务数据。
      </p>
      <RestrictedAppealPortal />
    </main>
  );
}
