import { submitVerification } from "@/actions/user";
import { VerificationForm } from "@/components/profile/verification-form";
import { VERIFICATION_STATUS_LABELS } from "@/constants/user";
import { requireUser } from "@/lib/server-auth";
import { getProfileDashboard } from "@/repositories/user-repository";

export const dynamic = "force-dynamic";

function formatDate(value: Date | null) {
  if (!value) {
    return "暂无";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export default async function VerificationPage() {
  const currentUser = await requireUser();
  const { user } = await getProfileDashboard(currentUser.id);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
      <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
        <section className="space-y-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div>
            <h1 className="text-3xl font-semibold text-slate-950">校园认证</h1>
            <p className="mt-2 text-sm text-slate-600">
              完成认证后更容易获得交易信任，也方便平台识别校内真实用户。
            </p>
          </div>

          <div className="rounded-[24px] bg-slate-50 p-5">
            <p className="text-sm text-slate-500">当前状态</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {VERIFICATION_STATUS_LABELS[user.verificationStatus]}
            </p>
            <div className="mt-4 space-y-2 text-sm text-slate-600">
              <p>学校：{user.schoolName}</p>
              <p>校区：{user.verification?.campusName ?? user.campus.name}</p>
              <p>学号后四位：{user.studentIdLast4 ?? "未填写"}</p>
              <p>提交时间：{formatDate(user.verification?.submittedAt ?? null)}</p>
              <p>审核时间：{formatDate(user.verification?.reviewedAt ?? null)}</p>
            </div>
          </div>

          {user.verification?.reviewNote ? (
            <div className="rounded-[24px] bg-amber-50 p-5 text-sm text-amber-700">
              审核备注：{user.verification.reviewNote}
            </div>
          ) : null}

          <div className="rounded-[24px] border border-slate-200 p-5 text-sm leading-7 text-slate-600">
            <p>提交说明：</p>
            <p>1. 请填写真实学校、校区和学号后四位信息。</p>
            <p>2. 学生证材料目前通过图片链接提交，方便管理员核验。</p>
            <p>3. 提交后可在当前页面持续查看审核状态与备注。</p>
          </div>
        </section>

        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <h2 className="text-2xl font-semibold text-slate-950">提交认证材料</h2>
            <p className="mt-2 text-sm text-slate-600">
              如果之前提交过，可以直接在这里更新信息后重新提交。
            </p>
          </div>
          <VerificationForm
            action={submitVerification}
            initialValues={{
              schoolName: user.verification?.schoolName ?? user.schoolName,
              campusName: user.verification?.campusName ?? user.campus.name,
              studentIdLast4: user.verification?.studentIdLast4 ?? user.studentIdLast4,
              studentCardImage: user.verification?.studentCardImage,
            }}
          />
        </section>
      </div>
    </div>
  );
}
