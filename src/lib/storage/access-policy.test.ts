import { describe, expect, it } from "vitest";
import {
  ASSET_CATEGORY_BY_UPLOAD_CATEGORY,
  assetAccessForCategory,
  bucketForAccess,
  buildPublicObjectUrl,
  CATEGORY_ACCESS,
  CATEGORY_DIRECTORY,
  keyAccessForAssetAccess,
} from "@/lib/storage/access-policy";

describe("access policy", () => {
  it("classifies listing content as public", () => {
    expect(CATEGORY_ACCESS.AVATAR).toBe("PUBLIC");
    expect(CATEGORY_ACCESS.PRODUCT).toBe("PUBLIC");
    expect(CATEGORY_ACCESS.RENTAL).toBe("PUBLIC");
    expect(CATEGORY_ACCESS.SERVICE).toBe("PUBLIC");
  });

  it("classifies evidence content as private", () => {
    expect(CATEGORY_ACCESS.VERIFICATION).toBe("PRIVATE");
    expect(CATEGORY_ACCESS.HANDOVER).toBe("PRIVATE");
    expect(CATEGORY_ACCESS.RETURN).toBe("PRIVATE");
    expect(CATEGORY_ACCESS.REPORT).toBe("PRIVATE");
  });

  it("maps upload categories to asset categories in both directions", () => {
    expect(ASSET_CATEGORY_BY_UPLOAD_CATEGORY.avatar).toBe("AVATAR");
    expect(ASSET_CATEGORY_BY_UPLOAD_CATEGORY.verification).toBe("VERIFICATION");
    expect(ASSET_CATEGORY_BY_UPLOAD_CATEGORY.handover).toBe("HANDOVER");
    expect(ASSET_CATEGORY_BY_UPLOAD_CATEGORY.return).toBe("RETURN");
    expect(ASSET_CATEGORY_BY_UPLOAD_CATEGORY.report).toBe("REPORT");
  });

  it("assigns distinct key directories per category", () => {
    const directories = Object.values(CATEGORY_DIRECTORY);
    expect(new Set(directories).size).toBe(directories.length);
    expect(CATEGORY_DIRECTORY.AVATAR).toBe("avatars");
    expect(CATEGORY_DIRECTORY.RETURN).toBe("return");
  });

  it("routes access levels to the configured buckets", () => {
    expect(bucketForAccess("PUBLIC")).toBe("campus-public");
    expect(bucketForAccess("PRIVATE")).toBe("campus-private");
    expect(keyAccessForAssetAccess("PUBLIC")).toBe("PUBLIC");
    expect(keyAccessForAssetAccess("PRIVATE")).toBe("PRIVATE");
  });

  it("builds public urls from the configured base url", () => {
    expect(buildPublicObjectUrl("public/products/u1/a.webp")).toBe(
      "http://localhost:9100/campus-public/public/products/u1/a.webp",
    );
    expect(assetAccessForCategory("VERIFICATION")).toBe("PRIVATE");
  });
});
