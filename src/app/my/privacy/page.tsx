import type { Metadata } from "next";
import Link from "next/link";
import { requireVerifiedPageUser } from "@/lib/server-auth";
import {
  getCurrentLegalDocuments,
  getUserAcceptanceHistory,
  getUserPolicyStatus,
} from "@/repositories/legal-repository";
import { listUserPrivacyRequests, describeBlockedReason } from "@/lib/privacy/privacy-request-service";
import {
  CancelRequestForm,
  DeleteAccountForm,
  ExportDataButton,
} from "@/components/privacy/privacy-settings-forms";

export const metadata: Metadata = {
  title: "隐私与数据 | 校园集市",
};

export const dynamic = "force-dynamic";

const REQUEST_STATUS_LABELS: Record<string, string> = {
  REQUESTED: "已提交",
  IN_PROGRESS: "处理中",
  BLOCKED: "已阻止",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  REJECTED: "已拒绝",
};

const REQUEST_TYPE_LABELS: Record<string, string> = {
  DATA_EXPORT: "数据导出",
  ACCOUNT_DELETION: "账号注销",
};

const SOURCE_LABELS: Record<string, string> = {
  SIGNUP: "注册时",
  RECONSENT: "重新同意",
  SETTINGS: "设置页",
};

export default async function PrivacySettingsPage() {
  // 隐私自助页不过 consent gate：退出权优先（见 server-auth.requireVerifiedPageUser）
  const user = await requireVerifiedPageUser();

  const [policyStatus, acceptanceHistory, requests, currentDocuments] = await Promise.all([
    getUserPolicyStatus(user.id),
    getUserAcceptanceHistory(user.id),
    listUserPrivacyRequests(user.id),
    getCurrentLegalDocuments().catch(() => []),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-950">隐私与数据</h1>
      <p className="mt-3 text-sm leading-7 text-slate-600">
        在这里管理你的协议同意记录、导出本人数据或申请注销账号。
      </p>

      {!policyStatus.compliant ? (
        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          你有尚未确认的新版协议，
          <Link href="/legal/accept" className="underline underline-offset-2">
            前往确认
          </Link>
          （确认前其他功能受限，但本页面的导出与注销始终可用）。
        </div>
      ) : null}

      {/* ---- 当前协议版本 + 同意状态 ---- */}
      <section className="mt-8 rounded-[28px] border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-950">当前协议版本</h2>
        {currentDocuments.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">平台协议尚未发布。</p>
        ) : (
          <ul className="mt-4 space-y-3 text-sm">
            {currentDocuments.map((document) => {
              const accepted = policyStatus.compliant ||
                !policyStatus.pending.some((pending) => pending.id === document.id);

              return (
                <li key={document.id} className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/legal/${document.slug}`}
                    className="text-sky-700 underline-offset-2 hover:underline"
                  >
                    《{document.title}》 v{document.version}
                  </Link>
                  <span
                    className={`rounded-full px-3 py-1 text-xs ${
                      accepted ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {accepted ? "已同意" : "待确认"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---- 同意历史 ---- */}
      <section className="mt-6 rounded-[28px] border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-950">我的同意历史</h2>
        {acceptanceHistory.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">暂无同意记录。</p>
        ) : (
          <ul className="mt-4 space-y-3 text-sm text-slate-600">
            {acceptanceHistory.map((acceptance) => (
              <li key={acceptance.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {acceptance.documentType} · v{acceptance.documentVersion}
                  <span className="ml-2 text-xs text-slate-400">
                    hash {acceptance.documentHash.slice(0, 12)}…
                  </span>
                </span>
                <span className="text-xs text-slate-500">
                  {SOURCE_LABELS[acceptance.source] ?? acceptance.source} ·{" "}
                  {acceptance.acceptedAt.toLocaleString("zh-CN")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- 数据导出 ---- */}
      <section className="mt-6 rounded-[28px] border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-950">导出我的数据</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          导出内容仅包含你本人的数据与必要的公共信息，不包含他人私密数据或平台内部凭据。
        </p>
        <div className="mt-4">
          <ExportDataButton />
        </div>
      </section>

      {/* ---- 隐私请求历史 ---- */}
      <section className="mt-6 rounded-[28px] border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-950">隐私请求记录</h2>
        {requests.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">暂无隐私请求。</p>
        ) : (
          <ul className="mt-4 space-y-3 text-sm">
            {requests.map((request) => (
              <li
                key={request.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 last:border-b-0"
                data-testid="privacy-request-row"
              >
                <span className="text-slate-700">
                  {REQUEST_TYPE_LABELS[request.type] ?? request.type}
                  {request.reasonCode ? (
                    <span className="ml-2 text-xs text-rose-600">
                      {describeBlockedReason(request.reasonCode)}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-3 text-xs text-slate-500">
                  <span
                    className={`rounded-full px-3 py-1 ${
                      request.status === "COMPLETED"
                        ? "bg-emerald-50 text-emerald-700"
                        : request.status === "BLOCKED" || request.status === "REJECTED"
                          ? "bg-rose-50 text-rose-700"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {REQUEST_STATUS_LABELS[request.status] ?? request.status}
                  </span>
                  {request.requestedAt.toLocaleString("zh-CN")}
                  {request.status === "REQUESTED" ? (
                    <CancelRequestForm requestId={request.id} />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- 账号注销 ---- */}
      <section className="mt-6 rounded-[28px] border border-rose-100 bg-white p-6">
        <h2 className="text-lg font-semibold text-rose-700">注销账号</h2>
        <div className="mt-4">
          <DeleteAccountForm />
        </div>
      </section>
    </div>
  );
}
