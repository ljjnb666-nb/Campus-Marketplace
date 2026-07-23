import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function importEnvModule() {
  vi.resetModules();
  return import("@/lib/env");
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("env", () => {
  it("reads required variables and applies defaults", async () => {
    process.env.DATABASE_URL = "postgresql://localhost:5432/campus";
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    process.env.NEXTAUTH_SECRET = "1234567890abcdef";
    delete process.env.APP_NAME;
    delete process.env.DEFAULT_CAMPUS_SLUG;
    delete process.env.UPLOAD_DIR;

    const { env } = await importEnvModule();

    expect(env.DATABASE_URL).toBe("postgresql://localhost:5432/campus");
    expect(env.NEXTAUTH_URL).toBe("http://localhost:3000");
    expect(env.NEXTAUTH_SECRET).toBe("1234567890abcdef");
    expect(env.APP_NAME).toBe("校园集市");
    expect(env.DEFAULT_CAMPUS_SLUG).toBe("main-campus");
    expect(env.UPLOAD_DIR).toBe("./public/uploads");
  });

  it("throws when required variables are invalid", async () => {
    process.env.DATABASE_URL = "";
    process.env.NEXTAUTH_URL = "not-a-url";
    process.env.NEXTAUTH_SECRET = "short";

    await expect(importEnvModule()).rejects.toThrow();
  });
});
