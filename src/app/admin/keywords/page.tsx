import { toggleModerationKeywordStatus, upsertModerationKeyword } from "@/actions/admin";
import { requireAdmin } from "@/lib/server-auth";
import { getAdminModerationKeywords } from "@/repositories/admin-repository";

export const dynamic = "force-dynamic";

const targetOptions = [
  { value: "GLOBAL", label: "全局" },
  { value: "PRODUCT", label: "商品" },
  { value: "ERRAND", label: "任务" },
  { value: "SERVICE", label: "服务" },
  { value: "MESSAGE", label: "消息" },
] as const;

export default async function AdminKeywordsPage() {
  await requireAdmin();
  const keywords = await getAdminModerationKeywords();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">违禁关键词管理</h1>
        <p className="mt-2 text-sm text-slate-600">
          新增或停用关键词后，会立刻影响商品、任务和服务发布时的内容过滤。
        </p>
      </div>

      <section className="mb-8 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">新增关键词</h2>
        <form
          action={upsertModerationKeyword}
          className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-[1.4fr_140px_120px_auto]"
        >
          <input
            name="keyword"
            placeholder="例如：代考"
            className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          />
          <select
            name="targetType"
            defaultValue="GLOBAL"
            className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          >
            {targetOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            name="isEnabled"
            defaultValue="true"
            className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          >
            <option value="true">启用</option>
            <option value="false">停用</option>
          </select>
          <button
            type="submit"
            className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            创建关键词
          </button>
        </form>
      </section>

      <div className="grid gap-4">
        {keywords.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            当前还没有关键词规则。
          </div>
        ) : (
          keywords.map((item) => (
            <article key={item.id} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-6 xl:grid-cols-[1fr_auto]">
                <form
                  action={upsertModerationKeyword}
                  className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1.4fr_140px_120px_auto]"
                >
                  <input type="hidden" name="keywordId" value={item.id} />
                  <input
                    name="keyword"
                    defaultValue={item.keyword}
                    className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                  />
                  <select
                    name="targetType"
                    defaultValue={item.targetType}
                    className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                  >
                    {targetOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    name="isEnabled"
                    defaultValue={item.isEnabled ? "true" : "false"}
                    className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                  >
                    <option value="true">启用</option>
                    <option value="false">停用</option>
                  </select>
                  <button
                    type="submit"
                    className="rounded-full border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    保存
                  </button>
                </form>

                <form action={toggleModerationKeywordStatus} className="flex items-center">
                  <input type="hidden" name="keywordId" value={item.id} />
                  <input type="hidden" name="isEnabled" value={item.isEnabled ? "false" : "true"} />
                  <button
                    type="submit"
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    {item.isEnabled ? "停用" : "启用"}
                  </button>
                </form>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
