import { describe, expect, it } from "vitest";
import {
  assertSafeObjectKey,
  buildObjectKey,
  isWellFormedObjectKey,
} from "@/lib/storage/object-key";

describe("buildObjectKey", () => {
  it("generates public keys with the documented layout", () => {
    const key = buildObjectKey({
      access: "PUBLIC",
      categoryDirectory: "products",
      userId: "user_123",
      fileExtension: ".webp",
      randomId: "0f14d0ab-9205-4d69-b6c1-9c39c0a53f47",
    });

    expect(key).toBe(
      "public/products/user_123/0f14d0ab-9205-4d69-b6c1-9c39c0a53f47.webp",
    );
  });

  it("generates private keys under the private root", () => {
    const key = buildObjectKey({
      access: "PRIVATE",
      categoryDirectory: "verification",
      userId: "user-1",
      fileExtension: ".png",
      randomId: "aabbccdd11223344",
    });

    expect(key).toBe("private/verification/user-1/aabbccdd11223344.png");
  });

  it("generates a fresh cryptographically random id per call", () => {
    const build = () =>
      buildObjectKey({
        access: "PUBLIC",
        categoryDirectory: "avatars",
        userId: "user-1",
        fileExtension: ".webp",
      });

    const first = build();
    const second = build();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^public\/avatars\/user-1\/[0-9a-f-]{36}\.webp$/);
  });

  it("rejects category directories outside the whitelist pattern", () => {
    expect(() =>
      buildObjectKey({
        access: "PUBLIC",
        categoryDirectory: "../escape",
        userId: "user-1",
        fileExtension: ".webp",
      }),
    ).toThrow("业务目录不合法");
  });

  it("rejects user ids with path separators or traversal segments", () => {
    for (const userId of ["../etc", "a/b", "..", "", "user id", "user\x00id"]) {
      expect(() =>
        buildObjectKey({
          access: "PUBLIC",
          categoryDirectory: "products",
          userId,
          fileExtension: ".webp",
        }),
      ).toThrow("用户 ID 不合法");
    }
  });

  it("rejects extensions outside the whitelist", () => {
    for (const fileExtension of [".exe", ".php", ".jpg.exe", "webp", ".svg", ""]) {
      expect(() =>
        buildObjectKey({
          access: "PUBLIC",
          categoryDirectory: "products",
          userId: "user-1",
          fileExtension,
        }),
      ).toThrow("扩展名不在白名单");
    }
  });

  it("rejects random ids that are too short or contain separators", () => {
    for (const randomId of ["short", "../../etc/passwd", "a b c d", ""]) {
      expect(() =>
        buildObjectKey({
          access: "PUBLIC",
          categoryDirectory: "products",
          userId: "user-1",
          fileExtension: ".webp",
          randomId,
        }),
      ).toThrow("随机 ID 不合法");
    }
  });

  it("rejects unknown access levels", () => {
    expect(() =>
      buildObjectKey({
        access: "SHARED" as "PUBLIC",
        categoryDirectory: "products",
        userId: "user-1",
        fileExtension: ".webp",
      }),
    ).toThrow("未知访问级别");
  });
});

describe("assertSafeObjectKey", () => {
  it("accepts well formed keys", () => {
    expect(() =>
      assertSafeObjectKey("public/products/user-1/abc123.webp"),
    ).not.toThrow();
  });

  it("rejects every traversal shape", () => {
    const maliciousKeys = [
      "../private/verification/user-1/card.webp",
      "public/../private/x.webp",
      "public/products/../../etc/passwd",
      "public/products/user-1/..",
      "public/products/user-1/.",
      "public//products/user-1/a.webp",
      "/public/products/user-1/a.webp",
      "public/products/user-1/a.webp/",
      "public\\products\\user-1\\a.webp",
      "public/products/user-1/a\n.webp",
      "",
      "a".repeat(513),
    ];
    for (const key of maliciousKeys) {
      expect(() => assertSafeObjectKey(key), `key: ${JSON.stringify(key)}`).toThrow();
    }
  });

  it("isWellFormedObjectKey mirrors assert without throwing", () => {
    expect(isWellFormedObjectKey("public/products/user-1/a.webp")).toBe(true);
    expect(isWellFormedObjectKey("../public/products/user-1/a.webp")).toBe(false);
  });
});
