import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txPolicyCreate,
  txPolicyFindUnique,
  txPolicyFindFirst,
  txPolicyUpdate,
  recordAdminAudit,
  acquireCampusVerificationPolicyLocks,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  txPolicyCreate: vi.fn(),
  txPolicyFindUnique: vi.fn(),
  txPolicyFindFirst: vi.fn(),
  txPolicyUpdate: vi.fn(),
  recordAdminAudit: vi.fn(),
  acquireCampusVerificationPolicyLocks: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campusVerificationPolicy: { create: txPolicyCreate },
  },
  withTransaction: withTransactionMock,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireCampusVerificationPolicyLocks,
}));

vi.mock("@/lib/governance/admin-audit", () => ({
  recordAdminAudit,
}));

import type { Prisma } from "@prisma/client";
import {
  computePolicyContentHash,
  createVerificationPolicy,
  getCurrentVerificationPolicy,
  publishVerificationPolicy,
  retireVerificationPolicy,
} from "@/lib/campus/verification-policy-service";

const txStub = {
  campusVerificationPolicy: {
    findUnique: txPolicyFindUnique,
    findFirst: txPolicyFindFirst,
    update: txPolicyUpdate,
  },
} as unknown as Prisma.TransactionClient;

const DRAFT = {
  id: "policy-1",
  campusId: "campus-a",
  version: 2,
  status: "DRAFT",
  title: "认证规则",
  instructions: "上传学生证",
  contentHash: "hash-abc",
  effectiveAt: new Date("2026-01-01T00:00:00Z"),
  publishedAt: null,
};

beforeEach(() => {
  withTransactionMock
    .mockReset()
    .mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(txStub),
    );
  txPolicyCreate.mockReset().mockResolvedValue({ ...DRAFT });
  txPolicyFindUnique.mockReset().mockResolvedValue({ ...DRAFT });
  txPolicyFindFirst.mockReset().mockResolvedValue(null);
  txPolicyUpdate.mockReset().mockResolvedValue({ ...DRAFT, status: "PUBLISHED", publishedAt: new Date() });
  recordAdminAudit.mockReset().mockResolvedValue(undefined);
  acquireCampusVerificationPolicyLocks.mockReset().mockResolvedValue(undefined);
});

describe("content hash（canonical content 的 SHA-256）", () => {
  it("matches sha256 hex of the UTF-8 instructions", () => {
    expect(computePolicyContentHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("publishVerificationPolicy（发布即不可变）", () => {
  it("publishes a draft under the campus policy lock", async () => {
    const published = await publishVerificationPolicy("policy-1", { actorId: "admin-1" });

    expect(acquireCampusVerificationPolicyLocks).toHaveBeenCalledWith(txStub, ["campus-a"]);
    expect(txPolicyUpdate).toHaveBeenCalledWith({
      where: { id: "policy-1" },
      data: expect.objectContaining({ status: "PUBLISHED", publishedAt: expect.any(Date) }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PUBLISH_VERIFICATION_POLICY",
        targetType: "CAMPUS_VERIFICATION_POLICY",
        campusId: "campus-a",
        metadata: { policyVersion: 2 },
      }),
      txStub,
    );
    expect(published.status).toBe("PUBLISHED");
  });

  it("is idempotent for already-published policies", async () => {
    txPolicyFindUnique.mockResolvedValue({ ...DRAFT, status: "PUBLISHED", publishedAt: new Date() });

    await publishVerificationPolicy("policy-1");

    expect(acquireCampusVerificationPolicyLocks).not.toHaveBeenCalled();
    expect(txPolicyUpdate).not.toHaveBeenCalled();
  });

  it("refuses republishing a retired policy", async () => {
    txPolicyFindUnique.mockResolvedValue({ ...DRAFT, status: "RETIRED" });

    await expect(publishVerificationPolicy("policy-1")).rejects.toMatchObject({
      code: "CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED",
    });
  });

  it("enforces ascending version order against the highest published version（锁内重读）", async () => {
    txPolicyFindFirst.mockResolvedValue({ version: 5 });

    await expect(publishVerificationPolicy("policy-1")).rejects.toMatchObject({
      code: "CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED",
    });
    expect(txPolicyUpdate).not.toHaveBeenCalled();
  });

  it("fails on missing policies", async () => {
    txPolicyFindUnique.mockResolvedValue(null);

    await expect(publishVerificationPolicy("ghost")).rejects.toMatchObject({
      code: "CAMPUS_VERIFICATION_POLICY_NOT_FOUND",
    });
  });
});

describe("retireVerificationPolicy", () => {
  it("retires under the campus policy lock with audit", async () => {
    txPolicyFindUnique.mockResolvedValue({ id: "policy-1", campusId: "campus-a" });
    txPolicyUpdate.mockResolvedValue({ ...DRAFT, status: "RETIRED" });

    await retireVerificationPolicy("policy-1", { actorId: "admin-1" });

    expect(acquireCampusVerificationPolicyLocks).toHaveBeenCalledWith(txStub, ["campus-a"]);
    expect(txPolicyUpdate).toHaveBeenCalledWith({
      where: { id: "policy-1" },
      data: { status: "RETIRED" },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "RETIRE_VERIFICATION_POLICY" }),
      txStub,
    );
  });
});

describe("getCurrentVerificationPolicy（current 解析确定性）", () => {
  it("resolves the highest published effective version deterministically", async () => {
    const rows = [{ id: "p-2", version: 2 }, { id: "p-1", version: 1 }];
    txPolicyCreate.mockReset();
    // prisma 路径：非 tx 调用走单例
    const prismaModule = await import("@/lib/prisma");
    const findMany = vi.fn().mockResolvedValue(rows);
    (prismaModule.prisma as unknown as Record<string, unknown>).campusVerificationPolicy = {
      create: txPolicyCreate,
      findMany,
    };

    const now = new Date("2026-06-01T00:00:00Z");
    const current = await getCurrentVerificationPolicy("campus-a", now);

    expect(findMany).toHaveBeenCalledWith({
      where: { campusId: "campus-a", status: "PUBLISHED", effectiveAt: { lte: now } },
      orderBy: [{ version: "desc" }, { id: "asc" }],
      take: 1,
    });
    expect(current).toEqual({ id: "p-2", version: 2 });
  });

  it("returns null when no published policy is effective", async () => {
    const prismaModule = await import("@/lib/prisma");
    const findMany = vi.fn().mockResolvedValue([]);
    (prismaModule.prisma as unknown as Record<string, unknown>).campusVerificationPolicy = {
      create: txPolicyCreate,
      findMany,
    };

    await expect(getCurrentVerificationPolicy("campus-a", new Date())).resolves.toBeNull();
  });
});

describe("createVerificationPolicy", () => {
  it("creates a draft with the content hash", async () => {
    const draft = await createVerificationPolicy({
      campusId: "campus-a",
      version: 1,
      title: "认证规则",
      instructions: "上传学生证",
    });

    expect(txPolicyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        campusId: "campus-a",
        version: 1,
        contentHash: computePolicyContentHash("上传学生证"),
      }),
    });
    expect(draft).toMatchObject({ id: "policy-1" });
  });
});
