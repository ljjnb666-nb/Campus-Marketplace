import { reviewVerification } from "@/actions/admin";
import { requireAdmin } from "@/lib/server-auth";
import { getVerificationReviewQueue } from "@/repositories/admin-repository";

export const dynamic = "force-dynamic";

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export default async function AdminVerificationsPage() {
  await requireAdmin();
  const items = await getVerificationReviewQueue();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">认证审核</h1>
        <p className="mt-2 text-sm text-slate-600">处理用户提交的校园认证材料。</p>
      </div>

      <div className="grid gap-4">
        {items.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            当前没有待审核认证。
          </div>
        ) : (
          items.map((item) => (
            <article key={item.id} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
                <div className="space-y-3 text-sm text-slate-600">
                  <h2 className="text-xl font-semibold text-slate-950">{item.user.name}</h2>
                  <p>邮箱：{item.user.email}</p>
                  <p>学校：{item.schoolName}</p>
                  <p>校区：{item.campusName}</p>
                  <p>当前用户校区：{item.user.campus.name}</p>
                  <p>学号后四位：{item.studentIdLast4}</p>
                  <p>提交时间：{formatDate(item.submittedAt)}</p>
                  <a
                    href={item.studentCardImage}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-slate-950 underline"
                  >
                    查看学生证材料
                  </a>
                  {item.reviewNote ? <p>上次备注：{item.reviewNote}</p> : null}
                </div>

                <form action={reviewVerification} className="space-y-3 rounded-[24px] bg-slate-50 p-5">
                  <input type="hidden" name="verificationId" value={item.id} />
                  <input type="hidden" name="userId" value={item.userId} />
                  <label className="flex flex-col gap-2 text-sm">
                    审核备注
                    <textarea
                      name="reviewNote"
                      rows={4}
                      defaultValue={item.reviewNote ?? ""}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                      placeholder="补充审核说明"
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="submit"
                      name="status"
                      value="VERIFIED"
                      className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                    >
                      通过认证
                    </button>
                    <button
                      type="submit"
                      name="status"
                      value="REJECTED"
                      className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                    >
                      驳回申请
                    </button>
                  </div>
                </form>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
