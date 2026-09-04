import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getLegalDocumentVersions,
  getLegalDocumentView,
  isLegalDocumentSlug,
  LEGAL_DOCUMENT_SLUGS,
  type LegalDocumentSlug,
} from "@/repositories/legal-repository";

export const dynamic = "force-dynamic";

const SLUG_TITLES: Record<LegalDocumentSlug, string> = {
  terms: "用户服务协议",
  privacy: "隐私政策",
  rules: "平台规则",
  prohibited: "禁止交易红线",
};

type PageProps = {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ version?: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { type } = await params;

  if (!isLegalDocumentSlug(type)) {
    return { title: "协议 | 校园集市" };
  }

  return { title: `${SLUG_TITLES[type]} | 校园集市` };
}

export default async function LegalDocumentPage({ params, searchParams }: PageProps) {
  const { type } = await params;
  const { version: versionParam } = await searchParams;

  if (!isLegalDocumentSlug(type)) {
    notFound();
  }

  const requestedVersion = versionParam ? Number.parseInt(versionParam, 10) : undefined;

  if (versionParam !== undefined && (requestedVersion === undefined || Number.isNaN(requestedVersion))) {
    notFound();
  }

  const [document, versions] = await Promise.all([
    getLegalDocumentView(type, requestedVersion),
    getLegalDocumentVersions(type),
  ]);

  if (!document) {
    // 请求了具体版本但版本不存在（或从未发布）
    if (requestedVersion !== undefined) {
      notFound();
    }

    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{SLUG_TITLES[type]}</h1>
        <div className="mt-6 rounded-[28px] border border-slate-200 bg-white p-6 text-sm leading-7 text-slate-600">
          该文档尚未发布。
        </div>
      </div>
    );
  }

  const isHistorical =
    requestedVersion !== undefined &&
    versions.length > 0 &&
    requestedVersion !== versions[versions.length - 1]?.version;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{document.title}</h1>
        <p className="text-sm text-slate-500">
          版本 v{document.version} · 生效于 {document.effectiveAt.toLocaleDateString("zh-CN")}
        </p>
      </div>

      {document.status === "RETIRED" ? (
        <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          该版本已退役，不再作为当前生效版本。最新版本请返回文档列表查看。
        </p>
      ) : null}

      {isHistorical ? (
        <p className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          你正在查看历史版本存档。内容自发布起未做任何修改（SHA-256 校验可追溯）。
        </p>
      ) : null}

      <article className="mt-6 rounded-[28px] border border-slate-200 bg-white p-6 sm:p-8">
        <div className="space-y-4 text-sm leading-7 text-slate-600">
          {document.content.split("\n").map((paragraph, index) =>
            paragraph.trim().length === 0 ? (
              <span key={index} className="block h-2" />
            ) : (
              <p key={index} className="whitespace-pre-wrap">
                {paragraph}
              </p>
            ),
          )}
        </div>
      </article>

      {versions.length > 1 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-slate-900">历史版本</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {versions.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-4">
                <Link
                  href={`/legal/${type}?version=${entry.version}`}
                  className={`transition hover:text-slate-950 ${
                    entry.version === document.version ? "font-semibold text-slate-950" : "text-slate-600"
                  }`}
                >
                  v{entry.version} · {entry.title}
                </Link>
                <span className="text-xs text-slate-400">
                  {entry.status === "RETIRED" ? "已退役" : entry.status === "PUBLISHED" ? "生效中" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <nav className="mt-10 flex flex-wrap gap-4 border-t border-slate-100 pt-6 text-sm text-slate-500">
        <Link href="/legal" className="transition hover:text-slate-950">
          全部协议与规则
        </Link>
        {Object.entries(LEGAL_DOCUMENT_SLUGS)
          .filter(([slug]) => slug !== type)
          .map(([slug, title]) => (
            <Link key={slug} href={`/legal/${slug}`} className="transition hover:text-slate-950">
              {title}
            </Link>
          ))}
      </nav>
    </div>
  );
}
