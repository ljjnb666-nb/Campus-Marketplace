export type SearchParamRule = {
  key: string;
  value?: string | null;
  /** Skip setting the key when value equals this sentinel (e.g. "ALL", "latest"). */
  omitWhen?: string;
};

export function parsePageParam(page?: string): number {
  return Math.max(1, Number(page ?? "1") || 1);
}

export function buildListingSearchParams(rules: SearchParamRule[]): URLSearchParams {
  const params = new URLSearchParams();

  for (const rule of rules) {
    const value = rule.value?.trim();
    if (!value) continue;
    if (rule.omitWhen !== undefined && value === rule.omitWhen) continue;
    params.set(rule.key, value);
  }

  return params;
}

export function hrefWithQuery(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function withSortParam(
  base: URLSearchParams,
  sort: string,
  defaultSort = "latest",
): URLSearchParams {
  const next = new URLSearchParams(base.toString());

  if (sort === defaultSort) {
    next.delete("sort");
  } else {
    next.set("sort", sort);
  }

  return next;
}
