import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { loginViaUI } from "../e2e/helpers/auth";
import { E2E_ACCOUNTS } from "../e2e/helpers/e2e";

/**
 * PHASE 7H FINAL REPAIR 2 — DUPLICATE DOM DIAGNOSTIC PROBE（§4-§12）。
 *
 * 目标：把"transient duplicate DOM"从截图猜测升级为可判定证据：
 *   RAW_SSR_COUNT（原始 HTTP HTML 中 marker 出现次数）
 *   HYDRATED_DOM_COUNT（live DOM 全量节点数）
 *   VISIBLE / HIDDEN（决定 Case B vs Case C）
 *   DUPLICATE_LIFETIME_MS（MutationObserver 全程记录 firstDuplicate→returnedToSingle）
 *   console/pageerror/requestfailed（hydration/router/abort 证据，不含任何凭据）
 *   html/body/main/nav/heading 结构计数
 *
 * 纯诊断：断言只用于"捕获得证/未复现"，不做任何 .first() 掩盖。
 * 运行方式（不入 release gate）：
 *   npx playwright test --config=playwright.diagnostic.config.ts --repeat-each=N --workers=W
 */

const EVIDENCE_DIR = "tests/diagnostics/.evidence";

type NodeEvidence = {
  index: number;
  outerHTML: string;
  isConnected: boolean;
  display: string;
  visibility: string;
  opacity: string;
  rect: { x: number; y: number; width: number; height: number };
  insideHidden: boolean;
  insideAriaHidden: boolean;
  ancestorChain: Array<{
    tag: string;
    id: string;
    cls: string;
    hidden: boolean;
    ariaHidden: string | null;
    dataMarkers: string;
  }>;
};

type DomEvidence = {
  allCount: number;
  visibleCount: number;
  hiddenCount: number;
  nodes: NodeEvidence[];
  htmlCount: number;
  bodyCount: number;
  mainCount: number;
  governanceNavCount: number;
  h1Count: number;
  h1Texts: string[];
};

type LogEntry = { t: number; kind: string; totalAfter: number };

declare global {
  interface Window {
    __dupLog?: LogEntry[];
  }
}

const PROBE_SCRIPT = (selector: string) => {
  const log: { t: number; kind: string; totalAfter: number }[] = [];
  const push = (kind: string) => {
    const total = document.querySelectorAll(selector).length;
    const entry = { t: Math.round(performance.now()), kind, totalAfter: total };
    log.push(entry);
    window.__dupLog = log;
  };
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(selector) || node.querySelector(selector)) push("added");
      }
      for (const node of Array.from(m.removedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(selector) || node.querySelector(selector)) push("removed");
      }
    }
  });
  const start = () =>
    observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) {
    start();
  }
};

function attachNetworkCapture(page: Page) {
  const events: Array<{
    kind: "console" | "pageerror" | "requestfailed" | "responsedoc";
    detail: string;
  }> = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      events.push({ kind: "console", detail: `[${message.type()}] ${message.text().slice(0, 500)}` });
    }
  });
  page.on("pageerror", (error) => {
    events.push({ kind: "pageerror", detail: String(error).slice(0, 800) });
  });
  page.on("requestfailed", (request) => {
    events.push({
      kind: "requestfailed",
      detail: `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`,
    });
  });
  page.on("response", (response) => {
    if (response.request().resourceType() === "document") {
      events.push({ kind: "responsedoc", detail: `${response.status()} ${response.url()}` });
    }
  });
  return events;
}

async function collectDomEvidence(page: Page, selector: string): Promise<DomEvidence> {
  return page.evaluate((sel: string) => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const describe = (el: HTMLElement, index: number): NodeEvidence => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const chain: NodeEvidence["ancestorChain"] = [];
      let ancestor = el.parentElement;
      while (ancestor && chain.length < 30) {
        const dataMarkers = Array.from(ancestor.attributes)
          .filter((attribute) => attribute.name.startsWith("data-") || attribute.name === "id")
          .map((attribute) => `${attribute.name}=${attribute.value.slice(0, 60)}`)
          .join(",");
        chain.push({
          tag: ancestor.tagName,
          id: ancestor.id,
          cls: (typeof ancestor.className === "string" ? ancestor.className : "").slice(0, 140),
          hidden: (ancestor as HTMLElement).hidden,
          ariaHidden: ancestor.getAttribute("aria-hidden"),
          dataMarkers,
        });
        ancestor = ancestor.parentElement;
      }
      return {
        index,
        outerHTML: el.outerHTML.slice(0, 400),
        isConnected: el.isConnected,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        insideHidden: !!el.closest("[hidden]"),
        insideAriaHidden: !!el.closest('[aria-hidden="true"]'),
        ancestorChain: chain,
      };
    };
    const nodeEvidences = nodes.map(describe);
    const isVisible = (el: HTMLElement) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const visible = nodes.filter(isVisible);
    const h1s = Array.from(document.querySelectorAll("h1"));
    return {
      allCount: nodes.length,
      visibleCount: visible.length,
      hiddenCount: nodes.length - visible.length,
      nodes: nodeEvidences,
      htmlCount: document.querySelectorAll("html").length,
      bodyCount: document.querySelectorAll("body").length,
      mainCount: document.querySelectorAll("main").length,
      governanceNavCount: document.querySelectorAll('nav[aria-label="治理控制台"]').length,
      h1Count: h1s.length,
      h1Texts: h1s.map((h) => h.textContent ?? ""),
    };
  }, selector);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let position = haystack.indexOf(needle);
  while (position !== -1) {
    count += 1;
    position = haystack.indexOf(needle, position + needle.length);
  }
  return count;
}

async function probeNavigation(input: {
  label: string;
  context: BrowserContext;
  path: string;
  markerSelector: string;
  rawMarkerNeedle: string;
  clientNavigationFrom?: string;
  clientNavigationLinkName?: string;
}) {
  const { context, path, markerSelector, rawMarkerNeedle } = input;
  const page = await context.newPage();
  const network = attachNetworkCapture(page);
  await context.addInitScript(PROBE_SCRIPT, markerSelector);

  let rawHtml: string | null = null;
  let rawStatus: number | null = null;
  if (input.clientNavigationFrom) {
    await page.goto(input.clientNavigationFrom);
    await page
      .getByRole("navigation", { name: "治理控制台" })
      .getByRole("link", { name: input.clientNavigationLinkName! })
      .click();
    await page.waitForURL((url) => url.pathname === path, { timeout: 20_000 });
  } else {
    const response = await page.goto(path);
    rawStatus = response?.status() ?? null;
    try {
      rawHtml = (await response?.text()) ?? null;
    } catch {
      rawHtml = null;
    }
  }

  await page.waitForLoadState("load");
  const early = await collectDomEvidence(page, markerSelector);
  // 观察窗口：hydration 完成后再取一次（MutationObserver 已全程记录）
  await page.waitForTimeout(2_500);
  const settled = await collectDomEvidence(page, markerSelector);
  const dupLog: LogEntry[] = await page.evaluate(
    () => (window as unknown as { __dupLog: LogEntry[] }).__dupLog ?? [],
  );

  const rawMarkerCount = rawHtml === null ? null : countOccurrences(rawHtml, rawMarkerNeedle);
  const rawHtmlCount = rawHtml === null ? null : countOccurrences(rawHtml, "<html");
  const rawMainCount = rawHtml === null ? null : countOccurrences(rawHtml, "<main");

  const evidence = {
    label: input.label,
    path,
    mode: input.clientNavigationFrom ? "D2-client-nav" : "D1-direct-goto",
    rawStatus,
    rawMarkerCount,
    rawHtmlCount,
    rawMainCount,
    early,
    settled,
    duplicateLifetime: (() => {
      const duplicateEntries = dupLog.filter((entry) => entry.totalAfter > 1);
      if (duplicateEntries.length === 0) return { everDuplicated: false, durationMs: 0 };
      const first = duplicateEntries[0]!.t;
      const last = duplicateEntries[duplicateEntries.length - 1]!.t;
      const logLength = dupLog.length;
      const lastEntry = dupLog[logLength - 1]!;
      return {
        everDuplicated: true,
        durationMs: lastEntry.totalAfter > 1 ? -1 : Math.max(0, last - first),
        firstDuplicateAt: first,
        returnedToSingleAt: lastEntry.totalAfter > 1 ? null : lastEntry.t,
        finalCount: lastEntry.totalAfter,
      };
    })(),
    mutationLogLength: dupLog.length,
    network: network.slice(0, 80),
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const safeName = input.label.replaceAll(/[^a-zA-Z0-9-]/g, "_");
  writeFileSync(`${EVIDENCE_DIR}/${safeName}.json`, JSON.stringify(evidence, null, 2));

  // 诊断可见性输出（list reporter 直显）
  console.log(
    `[PROBE] ${input.label} mode=${evidence.mode} raw=${rawMarkerCount} domEarly=${early.allCount}(v${early.visibleCount}/h${early.hiddenCount}) domSettled=${settled.allCount}(v${settled.visibleCount}/h${settled.hiddenCount}) lifetime=${JSON.stringify(evidence.duplicateLifetime)}`,
  );

  return { page, evidence };
}

test.describe("duplicate DOM probe（诊断，不入 release gate）", () => {
  test("SYS-D1: /governance/system 直接 goto", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUI(page, E2E_ACCOUNTS.admin.email, E2E_ACCOUNTS.admin.password, E2E_ACCOUNTS.admin.name);

    const { evidence } = await probeNavigation({
      label: `SYS-D1-${Date.now()}`,
      context,
      path: "/governance/system",
      markerSelector: '[data-testid="release-sha"]',
      rawMarkerNeedle: 'data-testid="release-sha"',
    });

    // 诊断断言：重复未复现 → allCount 恒 1；复现 → 输出证据并标记
    const duplicated = evidence.early.allCount > 1 || evidence.settled.allCount > 1;
    console.log(`[PROBE] SYS-D1 duplicated=${duplicated}`);
    await context.close();
  });

  test("SYS-D2: /governance → Link 客户端导航 → system", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUI(page, E2E_ACCOUNTS.admin.email, E2E_ACCOUNTS.admin.password, E2E_ACCOUNTS.admin.name);

    const { evidence } = await probeNavigation({
      label: `SYS-D2-${Date.now()}`,
      context,
      path: "/governance/system",
      markerSelector: '[data-testid="release-sha"]',
      rawMarkerNeedle: 'data-testid="release-sha"',
      clientNavigationFrom: "/governance",
      clientNavigationLinkName: "系统状态",
    });

    const duplicated = evidence.early.allCount > 1 || evidence.settled.allCount > 1;
    console.log(`[PROBE] SYS-D2 duplicated=${duplicated}`);
    await context.close();
  });

  test("CAMPUS-D1: 真实 campus detail 直接 goto", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUI(page, E2E_ACCOUNTS.admin.email, E2E_ACCOUNTS.admin.password, E2E_ACCOUNTS.admin.name);

    await page.goto("/governance/campuses?limit=50");
    const firstDetail = page.locator("article").first().getByRole("link", { name: "管理详情" });
    const href = await firstDetail.getAttribute("href");
    expect(href).toBeTruthy();

    const markerSelector = 'input[name="title"]';
    const { evidence } = await probeNavigation({
      label: `CAMPUS-D1b-${Date.now()}`,
      context,
      path: href!,
      markerSelector,
      rawMarkerNeedle: 'name="title"',
    });

    const duplicated = evidence.early.allCount > 1 || evidence.settled.allCount > 1;
    console.log(`[PROBE] CAMPUS-D1b duplicated=${duplicated}`);
    await context.close();
  });
});
