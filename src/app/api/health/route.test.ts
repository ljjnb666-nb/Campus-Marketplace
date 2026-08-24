import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { queryRawMock, errorSpy } = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: queryRawMock,
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
  },
}));

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    errorSpy.mockClear();
  });

  it("returns ok when the database responds", async () => {
    queryRawMock.mockResolvedValue([{ 1: 1 }]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns 503 and logs when the database is unreachable", async () => {
    queryRawMock.mockRejectedValue(new Error("connection refused"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("error");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("is a dynamic route response (NextResponse instance)", async () => {
    queryRawMock.mockResolvedValue([]);

    const response = await GET();

    expect(response).toBeInstanceOf(NextResponse);
  });
});
