import { expect, type Page } from "@playwright/test";

/**
 * PHASE 7H FINAL REPAIR 4：TRUE page settlement contract（§2）。
 *
 * 水合替换窗口内 raw DOM 短暂存在两份页面副本（visible SSR 树 +
 * [hidden] 壳中的 hydration 副本），而 getByRole 只匹配 a11y tree
 * （hidden 壳被排除）——单靠 role 断言 toHaveCount(1) 无法证明壳已移除。
 *
 * 本合同同时断言两层：
 *   1) accessible semantic heading = exactly 1（a11y tree 派生）
 *   2) raw DOM h1（精确文本匹配）= exactly 1（壳移除后才成立）
 *
 * raw 层使用精确正则（非子串 hasText）；禁止依赖 #S:0 / [id^="S:"] /
 * hidden implementation id / Next 内部 marker。
 */

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function expectHeadingSettled(
  page: Page,
  name: string,
): Promise<void> {
  const exactText = new RegExp(`^${escapeRegExp(name)}$`);

  // accessible semantic layer：hidden 壳结构性不进入 a11y tree
  await expect(
    page.getByRole("heading", { name, exact: true, level: 1 }),
  ).toHaveCount(1);

  // raw DOM layer：真实 <h1> 精确文本恰 1 —— hidden 壳移除后才成立
  await expect(page.locator("h1").filter({ hasText: exactText })).toHaveCount(1);
}
