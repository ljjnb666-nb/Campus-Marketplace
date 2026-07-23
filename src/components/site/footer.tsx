export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-10 text-sm sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <p className="font-semibold text-slate-950">校园集市</p>
          <p className="text-slate-600">面向大学校园的二手交易与服务撮合平台</p>
        </div>
        <p className="text-slate-500">当前版本基于本地 PostgreSQL、Prisma 与 Auth.js 凭证登录</p>
      </div>
    </footer>
  );
}
