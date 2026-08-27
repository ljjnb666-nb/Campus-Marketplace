import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaTransactionMock } = vi.hoisted(() => ({
  prismaTransactionMock: vi.fn(),
}));

// mock PrismaClient 构造器，让真实的 src/lib/prisma.ts 在测试中持有可控的客户端实例；
// $extends 直接返回自身，使导出的扩展客户端与底层实例共享同一个 $transaction mock
vi.mock("@prisma/client", () => ({
  PrismaClient: class FakePrismaClient {
    $transaction = prismaTransactionMock;
    $connect = vi.fn().mockResolvedValue(undefined);
    $disconnect = vi.fn().mockResolvedValue(undefined);
    $extends = vi.fn().mockReturnThis();
  },
  // prisma-soft-delete.ts 在模块加载期引用 Prisma 命名空间
  Prisma: {
    defineExtension: (extension: unknown) => extension,
    PrismaClientKnownRequestError: class extends Error {
      code: string;
      constructor(message: string, options?: { code?: string }) {
        super(message);
        this.code = options?.code ?? "P0000";
      }
    },
    prismaVersion: { client: "test" },
  },
}));

import { withTransaction } from "@/lib/prisma";

describe("withTransaction", () => {
  beforeEach(() => {
    prismaTransactionMock.mockReset();
  });

  it("passes the callback to prisma.$transaction with the default 10s timeout", async () => {
    const txClient = { user: { update: vi.fn() } };
    const callback = vi.fn().mockResolvedValue("result");
    prismaTransactionMock.mockResolvedValue("result");

    const result = await withTransaction(callback);

    expect(result).toBe("result");
    expect(prismaTransactionMock).toHaveBeenCalledTimes(1);
    const [passedCallback, options] = prismaTransactionMock.mock.calls[0];
    expect(options).toEqual({ timeout: 10_000 });
    // 回调经类型收窄包装后传入，运行时仍以事务 client 原样调用
    await passedCallback(txClient);
    expect(callback).toHaveBeenCalledWith(txClient);
  });

  it("uses a custom timeout when provided", async () => {
    prismaTransactionMock.mockResolvedValue(null);

    await withTransaction(vi.fn(), { timeout: 2_000 });

    expect(prismaTransactionMock).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 2_000,
    });
  });

  it("propagates transaction failures to the caller", async () => {
    const failure = new Error("tx aborted");
    prismaTransactionMock.mockRejectedValue(failure);

    await expect(withTransaction(vi.fn())).rejects.toThrow("tx aborted");
  });
});
