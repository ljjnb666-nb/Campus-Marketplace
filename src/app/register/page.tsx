import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/register-form";
import { listActiveCampuses } from "@/repositories/user-repository";
import { getCurrentLegalDocuments } from "@/repositories/legal-repository";

export const metadata: Metadata = {
  title: "注册 | 校园集市",
};

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const [campuses, requiredDocuments] = await Promise.all([
    listActiveCampuses().catch(() => []),
    getCurrentLegalDocuments().catch(() => []),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl px-4 py-16 sm:px-6">
      <div className="grid w-full gap-10 rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm lg:grid-cols-[0.9fr_1.1fr] lg:p-10">
        <div className="space-y-4">
          <p className="text-sm font-medium text-sky-700">创建账号</p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">注册校园集市</h1>
          <p className="text-sm leading-7 text-slate-600">
            选择你的校区并创建账号，即可开始发布商品、跑腿任务和技能服务。
          </p>
        </div>
        <RegisterForm
          campuses={campuses}
          requiredDocuments={requiredDocuments.map((document) => ({
            id: document.id,
            slug: document.slug,
            title: document.title,
            version: document.version,
          }))}
        />
      </div>
    </div>
  );
}
