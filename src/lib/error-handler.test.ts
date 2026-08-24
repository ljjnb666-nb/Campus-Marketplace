import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { z } from "zod";

function buildZodError(message: string): z.ZodError {
  const result = z.object({ field: z.string({ message }) }).safeParse({});
  if (!result.success) {
    return result.error;
  }
  throw new Error("unreachable: empty object always fails");
}

const { errorSpy } = vi.hoisted(() => ({
  errorSpy: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
  },
}));

import { actionErrorMessage, handleError } from "@/lib/error-handler";

describe("handleError", () => {
  beforeEach(() => {
    errorSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps ZodError to 400 with the first issue message", () => {
    const handled = handleError(buildZodError("订单号格式不正确"), "test");

    expect(handled).toEqual({ message: "订单号格式不正确", statusCode: 400 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("maps Prisma P2002 (unique violation) to 409", () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.19.3",
    });

    const handled = handleError(prismaError, "test");

    expect(handled.statusCode).toBe(409);
    expect(handled.message).toContain("已存在");
  });

  it("maps Prisma P2025 (record not found) to 404", () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "6.19.3",
    });

    const handled = handleError(prismaError, "test");

    expect(handled.statusCode).toBe(404);
    expect(handled.message).toContain("不存在");
  });

  it("logs and returns 500 for other Prisma known errors", () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
      code: "P2003",
      clientVersion: "6.19.3",
    });

    const handled = handleError(prismaError, "test");

    expect(handled.statusCode).toBe(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns generic 500 message for unknown errors without leaking details", () => {
    const handled = handleError(new Error("secret internal detail"), "test");

    expect(handled.statusCode).toBe(500);
    expect(handled.message).toBe("服务器内部错误，请稍后重试");
    expect(handled.message).not.toContain("secret");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("actionErrorMessage returns the message part only", () => {
    expect(actionErrorMessage(buildZodError("参数不正确"), "test")).toBe("参数不正确");
  });
});
