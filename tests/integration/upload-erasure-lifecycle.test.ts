import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";
import type { StorageClient } from "@/lib/storage/types";

// Real PostgreSQL lifecycle/locks. The storage adapter supplies deterministic
// PUT barriers; no external storage or existing user data is touched.
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const raw = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const objects = new Set<string>();
let onPut: (() => Promise<void>) | undefined;
vi.mock("@/lib/image-processing", () => ({
  ImageValidationError: class extends Error {},
  processUploadedImage: async () => ({ buffer: Buffer.alloc(64), mimeType: "image/webp", width: 4, height: 4, format: "webp" }),
}));

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function file(): File {
  return { name: "student-private-name.png", size: 16, type: "image/png", arrayBuffer: async () => new ArrayBuffer(16) } as File;
}

describe.skipIf(!databaseUrl)("upload versus erasure (real PostgreSQL)", () => {
  let campusId: string;
  const users: string[] = [];
  let upload: typeof import("@/lib/asset-service").uploadImageAsset;
  let erase: typeof import("@/lib/privacy/account-erasure").eraseAccount;
  let purge: typeof import("@/lib/asset-service").purgePendingDeleteAsset;
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== databaseUrl) throw new Error("Integration app and fixture datasource must match");
    const storage: StorageClient = {
      headBucket: async () => true,
      putObject: async ({ objectKey }) => { if (onPut) await onPut(); objects.add(objectKey); },
      deleteObject: async ({ objectKey }) => { objects.delete(objectKey); },
      headObject: async () => null, getObject: async () => null, getSignedReadUrl: async () => "unused",
    };
    (await import("@/lib/storage")).setStorageForTests(storage);
    ({ uploadImageAsset: upload, purgePendingDeleteAsset: purge } = await import("@/lib/asset-service"));
    ({ eraseAccount: erase } = await import("@/lib/privacy/account-erasure"));
    const campus = await raw!.campus.create({ data: { name: "Upload lifecycle", schoolName: "Test", slug: `upload-lifecycle-${randomUUID()}` } });
    campusId = campus.id;
  });
  afterAll(async () => {
    (await import("@/lib/storage")).setStorageForTests(null);
    if (raw) {
      await raw.uploadedAsset.deleteMany({ where: { ownerId: { in: users } } });
      await raw.user.deleteMany({ where: { id: { in: users } } });
      await raw.campus.deleteMany({ where: { id: campusId } });
      await raw.$disconnect();
      await (await import("@/lib/prisma")).prisma.$disconnect();
    }
  });
  async function user() {
    const row = await raw!.user.create({ data: { name: "Upload test", email: `${randomUUID()}@example.invalid`, schoolName: "Test", passwordHash: "test-only", campusId } });
    users.push(row.id);
    return row.id;
  }

  it("erasure holding USER lock wins; waiting upload creates no row or object", async () => {
    const userId = await user();
    const held = barrier(); const release = barrier();
    const erasing = erase(userId, undefined, async () => { held.release(); await release.promise; });
    await held.promise;
    const uploading = upload({ userId, category: "product", file: file() }).catch((error: unknown) => error);
    try { await waitForAdvisoryLockWaiter(raw!, [`USER:${userId}`]); }
    finally { release.release(); }
    await erasing;
    expect(await uploading).toMatchObject({ code: "ACCOUNT_INACTIVE" });
    expect(await raw!.uploadedAsset.count({ where: { ownerId: userId } })).toBe(0);
    expect((await raw!.user.findUniqueOrThrow({ where: { id: userId } })).storageUsedBytes).toBe(0);
  });

  it("erasure commits during external PUT; terminal upload queues deletion and cleanup converges", async () => {
    const userId = await user();
    const entered = barrier(); const release = barrier();
    onPut = async () => { entered.release(); await release.promise; };
    const uploading = upload({ userId, category: "product", file: file() }).catch((error: unknown) => error);
    await entered.promise;
    try {
      // This completes while PUT is held, proving no USER transaction spans IO.
      await erase(userId);
    } finally { onPut = undefined; release.release(); }
    expect(await uploading).toMatchObject({ code: "ACCOUNT_INACTIVE" });
    const asset = await raw!.uploadedAsset.findFirstOrThrow({ where: { ownerId: userId } });
    expect(asset).toMatchObject({ status: "PENDING_DELETE", originalFileName: null });
    expect(objects.has(asset.objectKey)).toBe(true);
    expect((await purge(asset.id)).outcome).toBe("PURGED");
    expect((await purge(asset.id)).outcome).toBe("NOOP");
    expect(objects.has(asset.objectKey)).toBe(false);
    expect((await raw!.user.findUniqueOrThrow({ where: { id: userId } })).storageUsedBytes).toBe(0);
  });

  it("completed upload is seen and queued by the subsequent erasure", async () => {
    const userId = await user();
    const result = await upload({ userId, category: "product", file: file() });
    await erase(userId);
    expect(await raw!.uploadedAsset.findUniqueOrThrow({ where: { id: result.assetId } }))
      .toMatchObject({ status: "PENDING_DELETE", originalFileName: null });
    expect((await purge(result.assetId)).outcome).toBe("PURGED");
  });
});
