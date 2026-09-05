import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentLegalDocuments } from "@/repositories/legal-repository";

export const metadata: Metadata = {
  title: "协议与规则 | 校园集市",
};

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  TERMS_OF_SERVICE: "用户协议",
  PRIVACY_POLICY: "隐私政策",
  PLATFORM_RULES: "平台规则",
  PROHIBITED_TRANSACTIONS: "禁止交易红线",
};

export default async function LegalIndexPage() {
  const documents = await getCurrentLegalDocuments().catch(() => []);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-950">协议与规则</h1>
      <p className="mt-3 text-sm leading-7 text-slate-600">
        以下为当前生效版本的协议与规则。全部文本按版本管理并可追溯，
        你的每次同意都会与具体版本绑定；版本更新时需要重新确认。
      </p>

      <div className="mt-8 space-y-4">
        {documents.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 text-sm text-slate-600">
            平台协议尚未发布。
          </div>
        ) : (
          documents.map((document) => (
            <Link
              key={document.id}
              href={`/legal/${document.slug}`}
              className="block rounded-[28px] border border-slate-200 bg-white p-6 transition hover:border-slate-300"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    {TYPE_LABELS[document.type] ?? document.type}
                  </p>
                  <p className="mt-1 text-lg font-semibold text-slate-950">
                    {document.title} · v{document.version}
                  </p>
                </div>
                <p className="text-xs text-slate-500">
                  生效于 {document.effectiveAt.toLocaleDateString("zh-CN")}
                </p>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
