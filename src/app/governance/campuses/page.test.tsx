import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireCampusManager,
  listGovernanceCampuses,
  getGovernanceCampusExists,
  getGovernanceCampusDetail,
  createGovernanceCampusAction,
  updateGovernanceCampusMetadataAction,
  activateGovernanceCampusAction,
  deactivateGovernanceCampusAction,
  createVerificationPolicyDraftAction,
  updateVerificationPolicyDraftAction,
  publishVerificationPolicyAction,
  retireVerificationPolicyAction,
} = vi.hoisted(() => ({
  requireCampusManager: vi.fn(),
  listGovernanceCampuses: vi.fn(),
  getGovernanceCampusExists: vi.fn(),
  getGovernanceCampusDetail: vi.fn(),
  createGovernanceCampusAction: vi.fn(),
  updateGovernanceCampusMetadataAction: vi.fn(),
  activateGovernanceCampusAction: vi.fn(),
  deactivateGovernanceCampusAction: vi.fn(),
  createVerificationPolicyDraftAction: vi.fn(),
  updateVerificationPolicyDraftAction: vi.fn(),
  publishVerificationPolicyAction: vi.fn(),
  retireVerificationPolicyAction: vi.fn(),
}));

vi.mock("@/lib/campus/campus-admin-access", () => ({ requireCampusManager }));
vi.mock("@/lib/campus/campus-governance-query", () => ({
  CAMPUS_LIST_DEFAULT_PAGE_SIZE: 25,
  CAMPUS_LIST_MAX_PAGE_SIZE: 50,
  listGovernanceCampuses,
  getGovernanceCampusExists,
  getGovernanceCampusDetail,
}));
vi.mock("@/actions/governance-campus", () => ({
  createGovernanceCampusAction,
  updateGovernanceCampusMetadataAction,
  activateGovernanceCampusAction,
  deactivateGovernanceCampusAction,
  createVerificationPolicyDraftAction,
  updateVerificationPolicyDraftAction,
  publishVerificationPolicyAction,
  retireVerificationPolicyAction,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import GovernanceCampusesPage from "@/app/governance/campuses/page";
import GovernanceCampusDetailPage from "@/app/governance/campuses/[campusId]/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GovernanceCampusesPage（/governance/campuses 列表）", () => {
  it("CA01：GLOBAL campus.manage → 渲染创建表单与 campus metadata 列表（无 PII）", async () => {
    requireCampusManager.mockResolvedValue({ user: { id: "mgr-1" } });
    listGovernanceCampuses.mockResolvedValue([
      {
        id: "campus-a",
        name: "主校区",
        slug: "main-campus",
        schoolName: "示例大学",
        district: "海淀区",
        isActive: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        activeMembershipCount: 12,
        pendingVerificationCount: 3,
      },
    ]);

    render(await GovernanceCampusesPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "校区管理" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "创建校区" })).toBeTruthy();
    expect(screen.getByText("主校区")).toBeTruthy();
    expect(screen.getByText("main-campus")).toBeTruthy();
    expect(screen.getByText("有效成员：12")).toBeTruthy();
    expect(screen.getByText("待审认证：3")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "管理详情" }).getAttribute("href"),
    ).toBe("/governance/campuses/campus-a");
    // §19 列表隐私：结构性无 email/证据/备注字段
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("@");
    expect(text).not.toContain("studentId");
    expect(listGovernanceCampuses).toHaveBeenCalledWith({ limit: 25 });
  });

  it("CA03：无权限 → 子树自守门 notFound（零列表查询）", async () => {
    requireCampusManager.mockImplementation(() => {
      throw new Error("NOT_FOUND");
    });

    await expect(
      GovernanceCampusesPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(listGovernanceCampuses).not.toHaveBeenCalled();
  });

  it("空校区列表 → 友好空态", async () => {
    requireCampusManager.mockResolvedValue({ user: { id: "mgr-1" } });
    listGovernanceCampuses.mockResolvedValue([]);

    render(await GovernanceCampusesPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("暂无校区。")).toBeTruthy();
  });
});

describe("GovernanceCampusDetailPage（两阶段读 + 策略管理面）", () => {
  const campusId = "campus-a";

  function mockDetail(overrides: Record<string, unknown> = {}) {
    requireCampusManager.mockResolvedValue({ user: { id: "mgr-1" } });
    getGovernanceCampusExists.mockResolvedValue({ id: campusId });
    getGovernanceCampusDetail.mockResolvedValue({
      campus: {
        id: campusId,
        name: "主校区",
        slug: "main-campus",
        schoolName: "示例大学",
        district: null,
        isActive: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      activeMembershipCount: 7,
      pendingVerificationCount: 2,
      policyVersions: [
        {
          id: "policy-2",
          version: 2,
          status: "PUBLISHED",
          title: "认证规则 v2",
          effectiveAt: "2026-09-10T00:00:00.000Z",
          publishedAt: "2026-09-10T00:00:00.000Z",
          contentHash: "hash2",
          createdAt: "2026-09-09T00:00:00.000Z",
        },
        {
          id: "policy-3",
          version: 3,
          status: "DRAFT",
          title: "认证规则 v3",
          effectiveAt: "2026-10-01T00:00:00.000Z",
          publishedAt: null,
          contentHash: "hash3",
          createdAt: "2026-09-19T00:00:00.000Z",
          draftInstructions: "新说明",
        },
      ],
      ...overrides,
    });
  }

  it("CA06/§29：Stage B 渲染 campus metadata + slug 不可变提示 + 策略版本（仅 DRAFT 显示编辑表单）", async () => {
    mockDetail();

    render(await GovernanceCampusDetailPage({ params: Promise.resolve({ campusId }) }));

    expect(screen.getByRole("heading", { name: "主校区" })).toBeTruthy();
    expect(screen.getByTestId("campus-slug").textContent).toBe("main-campus");
    expect(document.body.textContent).toContain("创建后不可修改");
    expect(screen.getByText("启用 / 停用")).toBeTruthy();
    expect(document.body.textContent).toContain("v2 · 认证规则 v2");
    expect(document.body.textContent).toContain("v3 · 认证规则 v3");
    // PUBLISHED 行不可编辑（仅 DRAFT 渲染 instructions 编辑表单）
    expect(screen.getByText("已发布策略内容不可修改（发布即不可变）")).toBeTruthy();
    expect(document.body.textContent).toContain("新说明");
    // CA08 相关：deactivate 表单存在（isActive true → 停用按钮）
    expect(screen.getByRole("button", { name: "停用校区" })).toBeTruthy();
  });

  it("CA05：Stage A 不存在 → notFound（无 Stage B 查询、无授权后读取）", async () => {
    requireCampusManager.mockResolvedValue({ user: { id: "mgr-1" } });
    getGovernanceCampusExists.mockResolvedValue(null);

    await expect(
      GovernanceCampusDetailPage({ params: Promise.resolve({ campusId }) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(getGovernanceCampusDetail).not.toHaveBeenCalled();
  });

  it("停用状态校区 → 渲染启用按钮（same-state 幂等由 service 承接）", async () => {
    mockDetail();
    getGovernanceCampusDetail.mockResolvedValue({
      campus: {
        id: campusId,
        name: "主校区",
        slug: "main-campus",
        schoolName: "示例大学",
        district: null,
        isActive: false,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      activeMembershipCount: 7,
      pendingVerificationCount: 2,
      policyVersions: [],
    });

    render(await GovernanceCampusDetailPage({ params: Promise.resolve({ campusId }) }));

    expect(screen.getByText("已停用")).toBeTruthy();
    expect(screen.getByRole("button", { name: "启用校区" })).toBeTruthy();
  });
});
