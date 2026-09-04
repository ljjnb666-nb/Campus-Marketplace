import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getUserPolicyStatus,
  LEGAL_DOCUMENT_SLUGS,
} from "@/repositories/legal-repository";
import { LegalAcceptForm } from "@/components/legal/legal-accept-form";

export const metadata: Metadata = {
  title: "确认平台协议 | 校园集市",
};

export const dynamic = "force-dynamic";

/**
 * 重新同意页（consent gate 的解除入口 UI）。
 *
 * 注意：本页有意不经过 requireUser()（那会形成 gate 循环），
 * 而是直接解析会话并读取同意状态。
 */
export default async function LegalAcceptPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const status = await getUserPolicyStatus(session.user.id);

  // 已经满足时无需停留
  if (status.compliant) {
    redirect("/");
  }

  const documents = status.pending.map((document) => ({
    id: document.id,
    slug: LEGAL_DOCUMENT_SLUGS[document.type],
    title: document.title,
    version: document.version,
    effectiveDate: document.effectiveAt.toLocaleDateString("zh-CN"),
    state: document.state,
    acceptedVersion: document.acceptedVersion,
  }));

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <p className="text-sm font-medium text-sky-700">协议更新</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
        请阅读并确认最新协议
      </h1>
      <p className="mt-3 text-sm leading-7 text-slate-600">
        平台协议已更新或你尚未确认当前版本。在确认之前，发布、下单、消息等
        需要账户身份的操作将暂停使用；浏览公开内容不受影响。
      </p>

      {documents.some((document) => document.state === "OUTDATED") ? (
        <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          你此前同意的是旧版本（v
          {documents
            .filter((document) => document.state === "OUTDATED")
            .map((document) => document.acceptedVersion)
            .join("、v")}
          ），旧版本的同意不会自动延续到新版本。
        </p>
      ) : null}

      <LegalAcceptForm
        documents={documents.map((document) => ({
          id: document.id,
          slug: document.slug,
          title: document.title,
          version: document.version,
          effectiveDate: document.effectiveDate,
        }))}
      />
    </div>
  );
}
