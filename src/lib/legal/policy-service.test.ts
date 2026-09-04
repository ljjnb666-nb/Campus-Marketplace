import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  transactionMock,
  legalDocumentFindMany,
  legalDocumentFindUnique,
  policyAcceptanceFindMany,
  policyAcceptanceFindUnique,
  policyAcceptanceCreate,
  loggerInfo,
  loggerWarn,
} = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  legalDocumentFindMany: vi.fn(),
  legalDocumentFindUnique: vi.fn(),
  policyAcceptanceFindMany: vi.fn(),
  policyAcceptanceFindUnique: vi.fn(),
  policyAcceptanceCreate: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    legalDocument: {
      findMany: legalDocumentFindMany,
      findUnique: legalDocumentFindUnique,
    },
    policyAcceptance: {
      findMany: policyAcceptanceFindMany,
      findUnique: policyAcceptanceFindUnique,
      create: policyAcceptanceCreate,
    },
  },
  withTransaction: transactionMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: vi.fn(),
  },
}));

import {
  getRequiredPolicies,
  getUserAcceptanceStatus,
  recordAcceptances,
  assertRequiredPoliciesAccepted,
} from "@/lib/legal/policy-service";
import { GovernanceError } from "@/lib/governance/domain-errors";

const NOW = new Date("2026-09-02T00:00:00Z");

function documentRow(overrides: {
  id: string;
  type: string;
  version: number;
  effectiveAt?: Date;
  status?: string;
  requiresAcceptance?: boolean;
}) {
  return {
    status: "PUBLISHED",
    requiresAcceptance: true,
    effectiveAt: new Date("2026-01-01T00:00:00Z"),
    contentHash: `hash-${overrides.id}`,
    title: `文档 ${overrides.type}`,
    ...overrides,
  };
}

/** getCurrentDocument 每 type 一次 findMany（orderBy version desc, take 1） */
function mockCurrentResolution(currents: Array<Record<string, unknown>>) {
  legalDocumentFindMany.mockImplementation(({ where }: { where: { type: string } }) => {
    const match = currents.find((document) => document.type === where.type);
    return Promise.resolve(match ? [match] : []);
  });
}

beforeEach(() => {
  legalDocumentFindMany.mockReset();
  legalDocumentFindUnique.mockReset();
  policyAcceptanceFindMany.mockReset();
  policyAcceptanceFindUnique.mockReset();
  policyAcceptanceCreate.mockReset();
  transactionMock.mockReset();
  loggerInfo.mockReset();
  loggerWarn.mockReset();
  // recordAcceptances 内部会调用 getUserAcceptanceStatus → findMany：
  // 默认"无任何同意记录"（pending == required 全集）
  policyAcceptanceFindMany.mockResolvedValue([]);
});

describe("getRequiredPolicies（current policy resolution）", () => {
  it("resolves the highest effective published version per type deterministically", async () => {
    const termsV2 = documentRow({ id: "doc-terms-2", type: "TERMS_OF_SERVICE", version: 2 });
    mockCurrentResolution([
      termsV2,
      documentRow({ id: "doc-privacy-1", type: "PRIVACY_POLICY", version: 1 }),
    ]);

    const required = await getRequiredPolicies(NOW);

    // 每个类型只取最高已生效版本；输出顺序按类型枚举序，与数据库返回顺序无关
    expect(required).toHaveLength(2);
    expect(required[0]).toMatchObject({ id: "doc-terms-2", version: 2 });
    expect(required[1]).toMatchObject({ id: "doc-privacy-1", version: 1 });

    // 解析顺序显式确定：orderBy version desc（CURRENT_POLICY_RESOLUTION_TEST）
    expect(legalDocumentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: "TERMS_OF_SERVICE",
          status: "PUBLISHED",
          effectiveAt: { lte: NOW },
        }),
        orderBy: [{ version: "desc" }, { id: "asc" }],
        take: 1,
      }),
    );
  });

  it("never treats a future-effective policy as current (FUTURE_POLICY_NOT_CURRENT)", async () => {
    // 未来生效文档：数据库 where effectiveAt <= now 直接排除；
    // 这里验证解析结果为空集合（无 required 政策 → gate 开放是显式语义）
    mockCurrentResolution([]);

    const required = await getRequiredPolicies(new Date("2026-09-02T00:00:00Z"));

    expect(required).toEqual([]);
  });
});

describe("getUserAcceptanceStatus（reconsent / legacy）", () => {
  it("marks accepted old version as OUTDATED (OLD_VERSION_RECONSENT_REQUIRED)", async () => {
    mockCurrentResolution([
      documentRow({ id: "doc-terms-2", type: "TERMS_OF_SERVICE", version: 2 }),
    ]);
    // 按类型匹配：用户在 TERMS 类型上最近一次接受的是 v1（不同 documentId）
    policyAcceptanceFindMany.mockResolvedValue([
      { documentId: "doc-terms-1", documentType: "TERMS_OF_SERVICE", documentVersion: 1 },
    ]);

    const status = await getUserAcceptanceStatus("user-1", NOW);

    // 接受的是 v1 → 不能算已同意当前 v2，必须重新同意
    expect(status.compliant).toBe(false);
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0]).toMatchObject({ state: "OUTDATED", acceptedVersion: 1 });
  });

  it("marks legacy users without any acceptance as MISSING and non-compliant (LEGACY_USER_NOT_AUTO_ACCEPTED)", async () => {
    mockCurrentResolution([
      documentRow({ id: "doc-terms-1", type: "TERMS_OF_SERVICE", version: 1 }),
    ]);
    // 旧用户没有任何 acceptance 记录
    policyAcceptanceFindMany.mockResolvedValue([]);

    const status = await getUserAcceptanceStatus("legacy-user", NOW);

    expect(status.compliant).toBe(false);
    expect(status.pending[0]).toMatchObject({ state: "MISSING", acceptedVersion: null });
  });

  it("is compliant when the exact current documents were accepted", async () => {
    mockCurrentResolution([
      documentRow({ id: "doc-terms-2", type: "TERMS_OF_SERVICE", version: 2 }),
    ]);
    policyAcceptanceFindMany.mockResolvedValue([
      { documentId: "doc-terms-2", documentType: "TERMS_OF_SERVICE", documentVersion: 2 },
    ]);

    const status = await getUserAcceptanceStatus("user-1", NOW);

    expect(status.compliant).toBe(true);
    expect(status.pending).toEqual([]);
  });
});

describe("assertRequiredPoliciesAccepted（consent gate）", () => {
  it("throws LEGAL_ACCEPTANCE_REQUIRED when pending documents exist", async () => {
    mockCurrentResolution([
      documentRow({ id: "doc-terms-2", type: "TERMS_OF_SERVICE", version: 2 }),
    ]);
    policyAcceptanceFindMany.mockResolvedValue([]);

    await expect(assertRequiredPoliciesAccepted("user-1", NOW)).rejects.toMatchObject({
      code: "LEGAL_ACCEPTANCE_REQUIRED",
      status: 403,
    });
  });
});

describe("recordAcceptances（acceptance evidence）", () => {
  const terms = documentRow({ id: "doc-terms-2", type: "TERMS_OF_SERVICE", version: 2 });
  const privacy = documentRow({ id: "doc-privacy-1", type: "PRIVACY_POLICY", version: 1 });

  function mockTwoRequired() {
    mockCurrentResolution([terms, privacy]);
  }

  it("is idempotent for repeated acceptance of the same document (ACCEPTANCE_IDEMPOTENCY)", async () => {
    mockTwoRequired();
    policyAcceptanceFindUnique.mockImplementation(
      async ({ where }: { where: { userId_documentId: { documentId: string } } }) => {
        const versionByDocument: Record<string, number> = {
          "doc-terms-2": 2,
          "doc-privacy-1": 1,
        };

        return {
          id: `acc-${where.userId_documentId.documentId}`,
          documentVersion: versionByDocument[where.userId_documentId.documentId],
        };
      },
    );
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ policyAcceptance: { findUnique: policyAcceptanceFindUnique, create: policyAcceptanceCreate } }),
    );

    const result = await recordAcceptances({
      userId: "user-1",
      documentIds: ["doc-terms-2", "doc-privacy-1"],
      source: "RECONSENT",
      now: NOW,
    });

    // 已存在同版本证据：跳过而非重复创建（(userId, documentId) 唯一）
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(policyAcceptanceCreate).not.toHaveBeenCalled();
  });

  it("treats concurrent duplicate creation (P2002) as idempotent success (ACCEPTANCE_CONCURRENCY)", async () => {
    mockTwoRequired();
    policyAcceptanceFindUnique.mockResolvedValue(null);
    policyAcceptanceCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ policyAcceptance: { findUnique: policyAcceptanceFindUnique, create: policyAcceptanceCreate } }),
    );

    const result = await recordAcceptances({
      userId: "user-1",
      documentIds: ["doc-terms-2", "doc-privacy-1"],
      source: "RECONSENT",
      now: NOW,
    });

    // 并发双击：另一请求已创建同一证据 → 幂等成功，不产生重复证据
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it("fails closed when the submitted set does not match the current required set (stale v1 submit)", async () => {
    mockTwoRequired();

    // 已发布但未进入当前 required 集合的文档（如未来生效的新版本 v3）：
    // 提交它不是"当前同意"→ NOT_CURRENT
    legalDocumentFindUnique.mockResolvedValue(
      documentRow({ id: "doc-terms-3", type: "TERMS_OF_SERVICE", version: 3 }),
    );

    // 用户停留在旧版本集合上提交（v3 发布后 required 集合变化，提交其 id）
    await expect(
      recordAcceptances({
        userId: "user-1",
        documentIds: ["doc-terms-3"],
        source: "RECONSENT",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "LEGAL_DOCUMENT_NOT_CURRENT" });

    // 杜撰 id：直接 NOT_FOUND
    legalDocumentFindUnique.mockResolvedValue(null);
    await expect(
      recordAcceptances({
        userId: "user-1",
        documentIds: ["ghost-id"],
        source: "RECONSENT",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "LEGAL_DOCUMENT_NOT_FOUND" });

    // 集合不完整同样拒绝
    legalDocumentFindUnique.mockReset();
    await expect(
      recordAcceptances({
        userId: "user-1",
        documentIds: ["doc-terms-2"],
        source: "RECONSENT",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "LEGAL_DOCUMENT_VERSION_CHANGED" });
  });

  it("never fabricates evidence: acceptance records snapshot type/version/hash", async () => {
    mockTwoRequired();
    policyAcceptanceFindUnique.mockResolvedValue(null);
    policyAcceptanceCreate.mockResolvedValue({});
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ policyAcceptance: { findUnique: policyAcceptanceFindUnique, create: policyAcceptanceCreate } }),
    );

    await recordAcceptances({
      userId: "user-1",
      documentIds: ["doc-terms-2", "doc-privacy-1"],
      source: "SIGNUP",
      now: NOW,
    });

    // 证据固化三元组快照，可独立于文档表证明"接受了哪个版本"
    expect(policyAcceptanceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        documentId: "doc-terms-2",
        documentType: "TERMS_OF_SERVICE",
        documentVersion: 2,
        documentHash: "hash-doc-terms-2",
        source: "SIGNUP",
      }),
    });
  });

  it("lets a partially-outdated user submit only the pending document (reconsent)", async () => {
    mockTwoRequired();
    // 用户对 PRIVACY 已接受当前版本；TERMS 是旧版本 → pending 仅 TERMS v2
    policyAcceptanceFindMany.mockResolvedValue([
      { documentId: "doc-privacy-1", documentType: "PRIVACY_POLICY", documentVersion: 1 },
    ]);
    policyAcceptanceFindUnique.mockImplementation(
      async ({ where }: { where: { userId_documentId: { documentId: string } } }) => {
        if (where.userId_documentId.documentId === "doc-privacy-1") {
          return { id: "acc-privacy", documentVersion: 1 };
        }

        return null;
      },
    );
    policyAcceptanceCreate.mockResolvedValue({});
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ policyAcceptance: { findUnique: policyAcceptanceFindUnique, create: policyAcceptanceCreate } }),
    );

    const result = await recordAcceptances({
      userId: "user-1",
      documentIds: ["doc-terms-2"],
      source: "RECONSENT",
      now: NOW,
    });

    // 只需补齐缺口：TERMS v2 新建证据；已接受的 PRIVACY 不被要求重交
    expect(result).toEqual({ created: 1, skipped: 0 });
    expect(policyAcceptanceCreate).toHaveBeenCalledTimes(1);
    expect(policyAcceptanceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentId: "doc-terms-2", source: "RECONSENT" }),
    });
  });

  it("rejects governance errors as GovernanceError instances", async () => {
    mockCurrentResolution([]);

    await expect(
      recordAcceptances({
        userId: "user-1",
        documentIds: ["ghost-id"],
        source: "RECONSENT",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(GovernanceError);
  });
});
