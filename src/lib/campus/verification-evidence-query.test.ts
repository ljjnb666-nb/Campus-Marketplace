import { beforeEach, describe, expect, it, vi } from "vitest";

const { uploadedAssetFindFirst } = vi.hoisted(() => ({
  uploadedAssetFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    uploadedAsset: { findFirst: uploadedAssetFindFirst },
  },
}));

import { resolveVerificationEvidenceDisplay } from "@/lib/campus/verification-review-query";

/**
 * RB-01 Repair 2：证据渲染解析（read-model 层 fail-closed）。
 * 仅"受控 asset 引用 ∧ VERIFICATION 类别 ∧ PRIVATE ∧ 绑定本认证 ∧ 存活未过期"
 * 返回 CONTROLLED；其余一律 UNAVAILABLE（伪造 id / 跨类绑定 / PUBLIC / legacy 值）。
 */

const VERIFICATION_ID = "verification-1";

function validAssetWhere(assetId: string) {
  return {
    id: assetId,
    category: "VERIFICATION",
    access: "PRIVATE",
    verificationId: VERIFICATION_ID,
    status: { in: ["UPLOADED", "ATTACHED"] },
    OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
  };
}

beforeEach(() => {
  uploadedAssetFindFirst.mockReset();
});

describe("resolveVerificationEvidenceDisplay（RB-01 fail-closed）", () => {
  it("TEST 1：受控引用且资产校验通过 → CONTROLLED", async () => {
    uploadedAssetFindFirst.mockResolvedValue({ id: "asset-1" });

    const result = await resolveVerificationEvidenceDisplay(VERIFICATION_ID, "asset:asset-1");

    expect(result).toEqual({ state: "CONTROLLED", ref: "asset:asset-1" });
    expect(uploadedAssetFindFirst).toHaveBeenCalledWith({
      where: validAssetWhere("asset-1"),
      select: { id: true },
    });
  });

  it("TEST 2/3：legacy /uploads 与外链 → UNAVAILABLE（不查询资产）", async () => {
    expect(await resolveVerificationEvidenceDisplay(VERIFICATION_ID, "/uploads/card-old.jpg")).toEqual({
      state: "UNAVAILABLE",
    });
    expect(await resolveVerificationEvidenceDisplay(VERIFICATION_ID, "https://example.com/card.jpg")).toEqual({
      state: "UNAVAILABLE",
    });
    expect(uploadedAssetFindFirst).not.toHaveBeenCalled();
  });

  it("TEST 4：未知/畸形值（含哨兵与恶意串）→ UNAVAILABLE", async () => {
    for (const value of ["legacy", "erased", "", "javascript:alert(1)"]) {
      expect(await resolveVerificationEvidenceDisplay(VERIFICATION_ID, value)).toEqual({
        state: "UNAVAILABLE",
      });
    }
    expect(uploadedAssetFindFirst).not.toHaveBeenCalled();
  });

  it("TEST 5：伪造 asset id（资产不存在）→ UNAVAILABLE", async () => {
    uploadedAssetFindFirst.mockResolvedValue(null);

    const result = await resolveVerificationEvidenceDisplay(VERIFICATION_ID, "asset:nonexistent");

    expect(result).toEqual({ state: "UNAVAILABLE" });
    expect(uploadedAssetFindFirst).toHaveBeenCalled();
  });

  it("TEST 6/7：跨类别绑定（AVATAR）或 PUBLIC 异常组合 → 查询不命中 → UNAVAILABLE", async () => {
    uploadedAssetFindFirst.mockResolvedValue(null);

    expect(await resolveVerificationEvidenceDisplay(VERIFICATION_ID, "asset:avatar-id")).toEqual({
      state: "UNAVAILABLE",
    });
    // where 子句必须同时约束 VERIFICATION 类别与 PRIVATE 访问级别
    const where = uploadedAssetFindFirst.mock.calls[0][0].where;
    expect(where.category).toBe("VERIFICATION");
    expect(where.access).toBe("PRIVATE");
    expect(where.verificationId).toBe(VERIFICATION_ID);
  });
});
