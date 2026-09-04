import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  privacyRequestFindUnique,
  privacyRequestCreate,
  privacyRequestUpdate,
  transactionMock,
  loggerInfo,
} = vi.hoisted(() => ({
  privacyRequestFindUnique: vi.fn(),
  privacyRequestCreate: vi.fn(),
  privacyRequestUpdate: vi.fn(),
  transactionMock: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    privacyRequest: {
      findUnique: privacyRequestFindUnique,
      create: privacyRequestCreate,
      update: privacyRequestUpdate,
    },
  },
  withTransaction: transactionMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const eraseAccountMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/privacy/account-erasure", () => ({
  eraseAccount: eraseAccountMock,
}));

import {
  canTransition,
  createAccountDeletionRequest,
  transitionPrivacyRequest,
} from "@/lib/privacy/privacy-request-service";

beforeEach(() => {
  privacyRequestFindUnique.mockReset();
  privacyRequestCreate.mockReset();
  privacyRequestUpdate.mockReset();
  transactionMock.mockReset();
  loggerInfo.mockReset();
  eraseAccountMock.mockReset();
});

describe("PrivacyRequest 状态机（PRIVACY_REQUEST_STATE_MACHINE）", () => {
  it("allows only the documented transitions", () => {
    expect(canTransition("REQUESTED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("REQUESTED", "CANCELLED")).toBe(true);
    expect(canTransition("IN_PROGRESS", "COMPLETED")).toBe(true);
    expect(canTransition("IN_PROGRESS", "BLOCKED")).toBe(true);
    expect(canTransition("BLOCKED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("BLOCKED", "REJECTED")).toBe(true);

    // 终态不可迁移；禁止跨状态乱跳
    expect(canTransition("COMPLETED", "REQUESTED")).toBe(false);
    expect(canTransition("COMPLETED", "BLOCKED")).toBe(false);
    expect(canTransition("CANCELLED", "IN_PROGRESS")).toBe(false);
    expect(canTransition("REQUESTED", "COMPLETED")).toBe(false);
    expect(canTransition("REQUESTED", "REJECTED")).toBe(false);
  });

  it("rejects illegal transitions through the explicit helper", async () => {
    privacyRequestFindUnique.mockResolvedValue({ id: "req-1", status: "COMPLETED" });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        privacyRequest: { findUnique: privacyRequestFindUnique, update: privacyRequestUpdate },
      }),
    );

    await expect(transitionPrivacyRequest("req-1", "BLOCKED")).rejects.toMatchObject({
      code: "PRIVACY_REQUEST_INVALID_TRANSITION",
    });
    // 非法迁移绝不落库
    expect(privacyRequestUpdate).not.toHaveBeenCalled();
  });

  it("throws PRIVACY_REQUEST_NOT_FOUND for a missing request", async () => {
    privacyRequestFindUnique.mockResolvedValue(null);
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        privacyRequest: { findUnique: privacyRequestFindUnique, update: privacyRequestUpdate },
      }),
    );

    await expect(transitionPrivacyRequest("ghost", "COMPLETED")).rejects.toMatchObject({
      code: "PRIVACY_REQUEST_NOT_FOUND",
    });
  });
});

describe("createAccountDeletionRequest（DUPLICATE_DELETION_REQUEST）", () => {
  it("surfaces the active-request invariant as PRIVACY_REQUEST_ALREADY_ACTIVE", async () => {
    // 部分唯一索引触发 P2002（并发/重复提交同用户注销）
    transactionMock.mockImplementation(async () => {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    });

    await expect(createAccountDeletionRequest("user-1")).rejects.toMatchObject({
      code: "PRIVACY_REQUEST_ALREADY_ACTIVE",
      status: 409,
    });
  });

  it("completes the request when erasure succeeds", async () => {
    // 模拟状态机真实流转：REQUESTED → IN_PROGRESS → COMPLETED
    let status = "REQUESTED";
    const requestRow = () => ({ id: "req-1", type: "ACCOUNT_DELETION", status });
    privacyRequestCreate.mockImplementation(
      async ({ data }: { data: { status: string } }) => {
        status = data.status;
        return requestRow();
      },
    );
    privacyRequestFindUnique.mockImplementation(async () => requestRow());
    privacyRequestUpdate.mockImplementation(async ({ data }: { data: { status: string } }) => {
      status = data.status;
      return requestRow();
    });
    eraseAccountMock.mockResolvedValue({
      userId: "user-1",
      erasedAt: new Date(),
      deactivatedListings: { products: 1, errandTasks: 0, serviceListings: 0, rentalListings: 0 },
      sensitiveAssetsMarkedForDeletion: 0,
    });

    // 让 withTransaction 直接在"外部 prisma 状态"上执行回调
    const client = {
      privacyRequest: {
        findUnique: privacyRequestFindUnique,
        create: privacyRequestCreate,
        update: privacyRequestUpdate,
      },
    };
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(client),
    );

    const outcome = await createAccountDeletionRequest("user-1");

    expect(outcome.status).toBe("COMPLETED");
    expect(eraseAccountMock).toHaveBeenCalledWith("user-1", client);
    expect(loggerInfo).toHaveBeenCalledWith(
      "privacy_request_completed",
      "privacy",
      expect.objectContaining({ requestId: "req-1", requestType: "ACCOUNT_DELETION" }),
    );
  });

  it("blocks without partial erasure when a hold exists", async () => {
    let status = "REQUESTED";
    privacyRequestCreate.mockImplementation(
      async ({ data }: { data: { status: string } }) => {
        status = data.status;
        return { id: "req-1", type: "ACCOUNT_DELETION", status };
      },
    );
    privacyRequestFindUnique.mockImplementation(async () => ({ id: "req-1", status }));
    privacyRequestUpdate.mockImplementation(async ({ data }: { data: { status: string } }) => {
      status = data.status;
      return { id: "req-1", status };
    });
    eraseAccountMock.mockRejectedValue(
      Object.assign(new Error("存在冻结"), { code: "ACTIVE_DATA_HOLD" }),
    );

    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        privacyRequest: {
          findUnique: privacyRequestFindUnique,
          create: privacyRequestCreate,
          update: privacyRequestUpdate,
        },
      }),
    );

    const outcome = await createAccountDeletionRequest("user-1");

    expect(outcome).toMatchObject({ status: "BLOCKED", reasonCode: "ACTIVE_DATA_HOLD" });
  });
});
