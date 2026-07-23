import Link from "next/link";

const recoveryLinks = [
  { href: "/", label: "回到首页" },
  { href: "/products", label: "浏览二手商品" },
  { href: "/errands", label: "查看跑腿任务" },
  { href: "/services", label: "寻找技能服务" },
  { href: "/profile", label: "进入个人中心" },
];

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[640px] w-full max-w-6xl items-center px-4 py-16 sm:px-6">
      <section className="relative w-full overflow-hidden rounded-[40px] border border-slate-200 bg-white p-8 shadow-sm sm:p-12">
        <div className="absolute -right-24 -top-24 size-64 rounded-full bg-slate-100" />
        <div className="absolute -bottom-32 left-20 size-72 rounded-full bg-amber-100/60" />

        <div className="relative max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.32em] text-slate-400">
            404 / 链接已失效
          </p>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-950 sm:text-6xl">
            页面不存在
          </h1>
          <p className="mt-5 text-base leading-7 text-slate-600 sm:text-lg">
            这个链接可能已经失效，或相关内容已被下架、删除。你可以回到首页继续浏览，也可以进入个人中心查看自己的商品、任务、订单和会话。
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            {recoveryLinks.map((item, index) => (
              <Link
                key={item.href}
                href={item.href}
                className={
                  index === 0
                    ? "rounded-full bg-slate-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
                    : "rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                }
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
