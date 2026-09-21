import Link from "next/link";

import {
  createGovernanceCampusAction,
} from "@/actions/governance-campus";
import { CreateCampusForm } from "@/components/governance/campus-admin-forms";
import { requireCampusManager } from "@/lib/campus/campus-admin-access";
import {
  CAMPUS_LIST_DEFAULT_PAGE_SIZE,
  decodeGovernanceCampusCursor,
  listGovernanceCampuses,
  type GovernanceCampusCursor,
} from "@/lib/campus/campus-governance-query";
import { governanceCampusListLimitSchema } from "@/validators/governance-campus";

export const dynamic = "force-dynamic";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function readParam(params: Record<string, string | string[] | undefined>, key: string) {
  const value = params[key];
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Phase 7H：校区管理列表（GLOBAL campus.manage ONLY）。
 * - 列表仅 campus metadata + 轻量 summary counts（§19：绝不读取认证证据 /
 *   email / 私有备注 / risk states / support descriptions）；
 * - 有界（§60）：default 25 / max 50；
 * - slug 不可变（§21）：创建表单是唯一 slug 入口，列表/编辑结构性无
 *   slug 修改路径。
 */
export default async function GovernanceCampusesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCampusManager();

  const params = await searchParams;

  let limit = CAMPUS_LIST_DEFAULT_PAGE_SIZE;
  const rawLimit = readParam(params, "limit");
  if (rawLimit !== undefined) {
    const parsedLimit = governanceCampusListLimitSchema.safeParse(rawLimit);
    if (parsedLimit.success) {
      limit = parsedLimit.data;
    }
  }

  // FR04：cursor 是 UNTRUSTED 分页位置——malformed 一律 fail closed
  // （统一 governance queue 的 malformed-cursor 行为：专用提示面板 +
  // 不执行列表查询，绝不静默回第一页）
  let cursor: GovernanceCampusCursor | null = null;
  let cursorInvalid = false;
  const rawCursor = readParam(params, "cursor");
  if (rawCursor !== undefined) {
    const decoded = decodeGovernanceCampusCursor(rawCursor);
    if (!decoded) {
      cursorInvalid = true;
    } else {
      cursor = decoded;
    }
  }

  const page = cursorInvalid
    ? { items: [], nextCursor: null }
    : await listGovernanceCampuses({ limit, cursor: cursor ?? undefined });
  const campuses = page.items;

  function buildPageHref(overrides: Record<string, string | undefined>) {
    const merged: Record<string, string | undefined> = {
      limit: String(limit),
      ...overrides,
    };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) {
        search.set(key, value);
      }
    }
    const qs = search.toString();
    return qs ? `/governance/campuses?${qs}` : "/governance/campuses";
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">校区管理</h1>
        <p className="mt-2 text-sm text-slate-600">
          校区是平台租户边界。启用/停用仅影响校区的可用性与准入配置，不会停用成员、下架内容或关闭在途工单。
        </p>
      </div>

      <section
        aria-label="创建校区"
        className="mb-8 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="mb-4 text-xl font-semibold text-slate-950">创建校区</h2>
        <CreateCampusForm action={createGovernanceCampusAction} />
      </section>

      {cursorInvalid ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          分页链接无效，请返回
          <Link href="/governance/campuses" className="ml-1 text-slate-900 underline">
            校区列表首页
          </Link>
          重新进入。
        </div>
      ) : campuses.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          暂无校区。
        </div>
      ) : (
        <div className="grid gap-4">
          {campuses.map((campus) => (
            <article
              key={campus.id}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-base font-semibold text-slate-950">{campus.name}</h3>
                <span
                  className={
                    campus.isActive
                      ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700"
                      : "rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
                  }
                >
                  {campus.isActive ? "启用中" : "已停用"}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {campus.slug}
                </span>
              </div>
              <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
                <p>学校：{campus.schoolName}</p>
                <p>所在区域：{campus.district ?? "—"}</p>
                <p>有效成员：{campus.activeMembershipCount}</p>
                <p>待审认证：{campus.pendingVerificationCount}</p>
                <p>创建时间：{formatDateTime(campus.createdAt)}</p>
              </div>
              <div className="mt-4">
                <Link
                  href={`/governance/campuses/${campus.id}`}
                  className="inline-block rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                >
                  管理详情
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}

      {page.nextCursor ? (
        <div className="mt-6 flex justify-end">
          <Link
            href={buildPageHref({ cursor: page.nextCursor })}
            className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
          >
            下一页
          </Link>
        </div>
      ) : null}
    </div>
  );
}
