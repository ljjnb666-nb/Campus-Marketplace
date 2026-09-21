import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  campusFindMany,
  membershipGroupBy,
  verificationRaw,
} = vi.hoisted(() => ({
  campusFindMany: vi.fn(),
  membershipGroupBy: vi.fn(),
  verificationRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campus: { findMany: campusFindMany },
    campusMembership: { groupBy: membershipGroupBy },
    $queryRaw: verificationRaw,
  },
}));

import {
  CAMPUS_LIST_DEFAULT_PAGE_SIZE,
  CAMPUS_LIST_MAX_PAGE_SIZE,
  decodeGovernanceCampusCursor,
  encodeGovernanceCampusCursor,
  listGovernanceCampuses,
} from "@/lib/campus/campus-governance-query";

/**
 * FR04：campus 列表 bounded keyset pagination 的 cursor 合同
 * （canonical-cursor SSOT 纪律：raw base64url 白名单 / exact JSON keys /
 * canonical ISO / non-empty id / re-encode equality；malformed fail closed）。
 * 全量遍历的 no-dup/no-skip 语义由真 PG PAGE-01..05 承担。
 */

function campusRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "campus-x",
    name: "主校区",
    slug: "main-campus",
    schoolName: "示例大学",
    district: null,
    isActive: true,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  campusFindMany.mockReset();
  membershipGroupBy.mockReset().mockResolvedValue([]);
  verificationRaw.mockReset().mockResolvedValue([]);
});

describe("GovernanceCampusCursor codec（PAGE-06..08 fail closed）", () => {
  it("encode → decode 往返保持同一 (createdAt, id) keyset 位置", () => {
    const cursor = { createdAt: new Date("2026-09-01T00:00:00.000Z"), id: "campus-1" };

    const raw = encodeGovernanceCampusCursor(cursor);
    const decoded = decodeGovernanceCampusCursor(raw);

    expect(decoded).toEqual(cursor);
  });

  it("PAGE-06：malformed raw（非 base64url 字符）→ null", () => {
    expect(decodeGovernanceCampusCursor("not-a-valid-cursor!!!")).toBeNull();
  });

  it("PAGE-07：noncanonical base64url（标准 base64 含 +/ 与 padding）→ null", () => {
    const raw = Buffer.from(
      JSON.stringify({ createdAt: "2026-09-01T00:00:00.000Z", id: "campus-1" }),
    ).toString("base64");
    expect(raw).toMatch(/[+/=]/); // 确认构造出非 base64url 字符
    expect(decodeGovernanceCampusCursor(raw)).toBeNull();
  });

  it("PAGE-07b：exact JSON keys——多键/缺键 payload → null", () => {
    const extraKey = Buffer.from(
      JSON.stringify({ createdAt: "2026-09-01T00:00:00.000Z", id: "campus-1", extra: 1 }),
    ).toString("base64url");
    expect(decodeGovernanceCampusCursor(extraKey)).toBeNull();

    const missingId = Buffer.from(
      JSON.stringify({ createdAt: "2026-09-01T00:00:00.000Z" }),
    ).toString("base64url");
    expect(decodeGovernanceCampusCursor(missingId)).toBeNull();
  });

  it("PAGE-08：invalid ISO（timezone-less / 非时间字符串）→ null", () => {
    const timezoneLess = encodeGovernanceCampusCursor({
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      id: "campus-1",
    });
    // 构造 canonical base64url 但 createdAt 非 canonical ISO
    const tampered = Buffer.from(
      JSON.stringify({ createdAt: "2026-09-01T09:00", id: "campus-1" }),
    ).toString("base64url");
    expect(tampered).not.toEqual(timezoneLess);
    expect(decodeGovernanceCampusCursor(tampered)).toBeNull();

    const notADate = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "campus-1" }),
    ).toString("base64url");
    expect(decodeGovernanceCampusCursor(notADate)).toBeNull();

    const emptyId = Buffer.from(
      JSON.stringify({ createdAt: "2026-09-01T00:00:00.000Z", id: "" }),
    ).toString("base64url");
    expect(decodeGovernanceCampusCursor(emptyId)).toBeNull();
  });
});

describe("listGovernanceCampuses（keyset 分页查询合同）", () => {
  it("无 cursor：orderBy (createdAt asc, id asc) + take limit+1；末条生成 nextCursor", async () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      campusRow({ id: `campus-${index}`, createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)) }),
    );
    campusFindMany.mockResolvedValue([...rows, campusRow({ id: "campus-next" })]);

    const page = await listGovernanceCampuses({ limit: 25 });

    expect(campusFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 26,
      }),
    );
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).toEqual(
      encodeGovernanceCampusCursor({ createdAt: rows[24]!.createdAt, id: "campus-24" }),
    );
    expect(CAMPUS_LIST_DEFAULT_PAGE_SIZE).toBe(25);
    expect(CAMPUS_LIST_MAX_PAGE_SIZE).toBe(50);
  });

  it("有 cursor：keyset 谓词 = createdAt > ∨ (createdAt = ∧ id >)", async () => {
    campusFindMany.mockResolvedValue([]);

    const cursor = { createdAt: new Date("2026-09-01T00:00:00.000Z"), id: "campus-1" };
    await listGovernanceCampuses({ limit: 25, cursor });

    const where = campusFindMany.mock.calls[0][0].where;
    expect(where).toEqual({
      OR: [
        { createdAt: { gt: cursor.createdAt } },
        { createdAt: { equals: cursor.createdAt }, id: { gt: cursor.id } },
      ],
    });
  });

  it("末页：不足 limit+1 → nextCursor null", async () => {
    campusFindMany.mockResolvedValue([campusRow({ id: "campus-last" })]);

    const page = await listGovernanceCampuses({ limit: 25 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
