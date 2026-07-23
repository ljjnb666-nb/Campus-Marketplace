import Link from "next/link";

function buildPageHref(pathname: string, params: URLSearchParams, page: number) {
  const nextParams = new URLSearchParams(params.toString());

  if (page <= 1) {
    nextParams.delete("page");
  } else {
    nextParams.set("page", String(page));
  }

  const query = nextParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function Pagination({
  pathname,
  params,
  page,
  totalPages,
}: {
  pathname: string;
  params: URLSearchParams;
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) {
    return null;
  }

  const pages = Array.from({ length: totalPages }, (_, index) => index + 1).filter((value) => {
    return value === 1 || value === totalPages || Math.abs(value - page) <= 1;
  });

  const displayPages = pages.reduce<number[]>((acc, value) => {
    const previous = acc[acc.length - 1];
    if (previous && value - previous > 1) {
      acc.push(-1);
    }
    acc.push(value);
    return acc;
  }, []);

  return (
    <nav className="mt-8 flex flex-wrap items-center justify-center gap-2">
      <Link
        href={buildPageHref(pathname, params, Math.max(1, page - 1))}
        aria-disabled={page <= 1}
        className={`rounded-full px-4 py-2 text-sm font-medium transition ${
          page <= 1
            ? "pointer-events-none border border-slate-200 text-slate-300"
            : "border border-slate-200 text-slate-700 hover:border-slate-300 hover:text-slate-950"
        }`}
      >
        上一页
      </Link>
      {displayPages.map((item, index) =>
        item === -1 ? (
          <span key={`gap-${index}`} className="px-2 text-sm text-slate-400">
            ...
          </span>
        ) : (
          <Link
            key={item}
            href={buildPageHref(pathname, params, item)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              item === page
                ? "bg-slate-950 text-white"
                : "border border-slate-200 text-slate-700 hover:border-slate-300 hover:text-slate-950"
            }`}
          >
            {item}
          </Link>
        ),
      )}
      <Link
        href={buildPageHref(pathname, params, Math.min(totalPages, page + 1))}
        aria-disabled={page >= totalPages}
        className={`rounded-full px-4 py-2 text-sm font-medium transition ${
          page >= totalPages
            ? "pointer-events-none border border-slate-200 text-slate-300"
            : "border border-slate-200 text-slate-700 hover:border-slate-300 hover:text-slate-950"
        }`}
      >
        下一页
      </Link>
    </nav>
  );
}
