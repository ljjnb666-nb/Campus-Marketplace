import Link from "next/link";

const safetyTips = [
  {
    title: "优先选择同校区当面交易",
    description: "约在教学楼门口、图书馆大厅或宿舍楼下等公共区域见面，降低陌生交易风险。",
  },
  {
    title: "付款前先确认实物和服务细节",
    description: "二手商品建议现场验货，跑腿与技能服务建议先确认时间、地点、交付标准。",
  },
  {
    title: "遇到异常内容立即举报",
    description: "发现诈骗、学术作弊、违禁交易或骚扰消息，可直接在详情页或会话页发起举报。",
  },
  {
    title: "优先选择已认证用户",
    description: "查看对方认证状态、完成订单数和好评率，优先和校内实名认证同学完成交易。",
  },
] as const;

export function SafetySection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              安全交易提示
            </span>
            <h2 className="mt-4 text-2xl font-semibold text-slate-950">校园里的东西，尽量在校园里当面确认和解决。</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              第一版以线下付款和站内沟通为主，平台已接入权限校验、违禁词过滤、校园认证和举报处理链路。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/rules"
              className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            >
              查看平台规则
            </Link>
            <Link
              href="/reports"
              className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              前往举报中心
            </Link>
          </div>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {safetyTips.map((item) => (
            <article key={item.title} className="rounded-[24px] border border-slate-200 bg-slate-50 p-5">
              <h3 className="text-base font-semibold text-slate-950">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{item.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
