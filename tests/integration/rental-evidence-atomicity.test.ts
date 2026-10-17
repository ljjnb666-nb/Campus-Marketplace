import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { purgeUserFixtureFromAppDatabase } from "./helpers/raw-cleanup";

/**
 * R10: production Server Action + real Prisma interactive transaction.
 * Only entry identity and the already-completed S3 upload are stubbed:
 * all domain writes, row locking, UploadedAsset CAS and COMMIT/ROLLBACK
 * execute against a real PostgreSQL database.
 */
vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const runTag = "r10pg-" + randomUUID().slice(0, 8);
const campusSlug = "r10-atomicity-it-campus";

vi.mock("@/lib/server-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server-auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upload")>()),
  uploadImageAsset: vi.fn(),
}));
vi.mock("@/lib/revalidate", () => ({
  revalidateRentalOrderCreationViews: vi.fn(),
  revalidateRentalOrderListViews: vi.fn(),
  revalidateRentalOrderViews: vi.fn(),
}));

describe.skipIf(!integrationDatabaseUrl)("R10: pickup evidence and asset binding atomically commit (real PostgreSQL)", () => {
  let raw: PrismaClient;
  let confirmPickup: typeof import("@/actions/rental-order").confirmPickup;
  let requireUser: typeof import("@/lib/server-auth").requireUser;
  let uploadImageAsset: typeof import("@/lib/upload").uploadImageAsset;
  let campusId = "";
  let categoryId = "";
  let ownerId = "";
  let renterId = "";
  const orderIds: string[] = [];
  const listingIds: string[] = [];
  const assetIds: string[] = [];

  beforeAll(async () => {
    raw = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl! } },
    });
    const campus = await raw.campus.upsert({
      where: { slug: campusSlug },
      create: { slug: campusSlug, name: "R10 资产原子性测试校区", schoolName: "集成测试大学" },
      update: {},
    });
    campusId = campus.id;
    const category = await raw.rentalCategory.create({
      data: { slug: runTag, name: "R10-" + runTag },
    });
    categoryId = category.id;
    const owner = await raw.user.create({
      data: {
        email: runTag + "-owner@it.local", name: "R10 owner", passwordHash: "test-only",
        schoolName: "集成测试大学", campusId, status: "ACTIVE",
      },
    });
    ownerId = owner.id;
    const renter = await raw.user.create({
      data: {
        email: runTag + "-renter@it.local", name: "R10 renter", passwordHash: "test-only",
        schoolName: "集成测试大学", campusId, status: "ACTIVE",
      },
    });
    renterId = renter.id;
    await raw.campusMembership.createMany({
      data: [
        { campusId, userId: ownerId, status: "ACTIVE" },
        { campusId, userId: renterId, status: "ACTIVE" },
      ],
    });

    ({ confirmPickup } = await import("@/actions/rental-order"));
    ({ requireUser } = await import("@/lib/server-auth"));
    ({ uploadImageAsset } = await import("@/lib/upload"));
  });

  beforeEach(() => {
    vi.mocked(requireUser).mockReset().mockImplementation(async () =>
      ({ id: renterId } as Awaited<ReturnType<typeof requireUser>>));
    vi.mocked(uploadImageAsset).mockReset();
  });

  afterAll(async () => {
    if (!raw) return;
    // Test owns the private assets: no actual S3 objects are created.
    await raw.uploadedAsset.deleteMany({ where: { id: { in: assetIds } } });
    await raw.rentalOrder.deleteMany({ where: { id: { in: orderIds } } });
    await raw.rentalListing.deleteMany({ where: { id: { in: listingIds } } });
    if (categoryId) await raw.rentalCategory.deleteMany({ where: { id: categoryId } });
    // User removal is RESTRICTed by membership rows; clean test-owned edges first.
    await raw.notification.deleteMany({ where: { userId: { in: [ownerId, renterId] } } });
    await raw.campusMembership.deleteMany({ where: { userId: { in: [ownerId, renterId] } } });
    for (const userId of [ownerId, renterId]) {
      if (userId) await purgeUserFixtureFromAppDatabase(userId);
    }
    await raw.$disconnect();
    // Reuse the stable Campus rather than altering concurrent campus.count() suites.
  });

  async function fixtureOrder() {
    const listing = await raw.rentalListing.create({
      data: {
        title: "R10 取货凭证事务-" + runTag, description: "真实 PG 回滚证据",
        condition: "NEW", price: "20.00", pricingUnit: "PER_DAY",
        depositAmount: "50.00", minimumDuration: 1, maximumDuration: 30,
        totalQuantity: 1, availableQuantity: 1, pickupLocation: "南门",
        returnLocation: "南门", status: "AVAILABLE", ownerId, campusId, categoryId,
      },
    });
    listingIds.push(listing.id);
    const order = await raw.rentalOrder.create({
      data: {
        orderNumber: "RT-" + randomUUID(), rentalListingId: listing.id,
        ownerId, renterId, startTime: new Date("2026-10-20T00:00:00Z"),
        endTime: new Date("2026-10-21T00:00:00Z"), quantity: 1,
        unitPriceSnapshot: "20.00", pricingUnitSnapshot: "PER_DAY",
        rentalDuration: 1, rentalAmount: "20.00", depositAmount: "50.00",
        finalAmount: "70.00", paymentStatus: "OFFLINE_PENDING",
        depositStatus: "NOT_REQUIRED", status: "PENDING_PICKUP",
        pickupLocationSnapshot: "南门", returnLocationSnapshot: "南门",
      } satisfies Prisma.RentalOrderUncheckedCreateInput,
    });
    orderIds.push(order.id);
    return order.id;
  }

  async function fixtureAsset(assetOwnerId: string, status: "UPLOADED" | "PENDING_DELETE" = "UPLOADED") {
    const asset = await raw.uploadedAsset.create({
      data: {
        ownerId: assetOwnerId, category: "HANDOVER", access: "PRIVATE",
        bucket: "r10-it-private", objectKey: runTag + "/" + randomUUID() + ".png",
        mimeType: "image/png", sizeBytes: 128, status,
      },
    });
    assetIds.push(asset.id);
    return asset.id;
  }

  async function submit(orderId: string, assetId: string) {
    vi.mocked(uploadImageAsset).mockResolvedValueOnce({
      assetId, access: "PRIVATE",
    } as Awaited<ReturnType<typeof uploadImageAsset>>);
    const form = new FormData();
    form.set("orderId", orderId);
    form.set("role", "renter");
    form.append("photos", new File(["test-png"], "handover.png", { type: "image/png" }));
    return confirmPickup(form);
  }

  it("R10-PG-01: unauthorized asset bind short-count rolls back already-written handover reference", async () => {
    const orderId = await fixtureOrder();
    const wrongOwnerAsset = await fixtureAsset(ownerId);
    const result = await submit(orderId, wrongOwnerAsset);
    expect(result.success).toBe(false);
    expect(result.message).toContain("照片状态已变化");
    expect(await raw.rentalHandoverRecord.findUnique({ where: { orderId } })).toBeNull();
    expect((await raw.rentalOrder.findUniqueOrThrow({ where: { id: orderId } })).status)
      .toBe("PENDING_PICKUP");
    const asset = await raw.uploadedAsset.findUniqueOrThrow({ where: { id: wrongOwnerAsset } });
    expect(asset.status).toBe("UPLOADED");
    expect(asset.rentalOrderId).toBeNull();
  });

  it("R10-PG-02: cleanup-marked asset cannot leave a committed handover reference", async () => {
    const orderId = await fixtureOrder();
    const staleAsset = await fixtureAsset(renterId, "PENDING_DELETE");
    const result = await submit(orderId, staleAsset);
    expect(result.success).toBe(false);
    expect(await raw.rentalHandoverRecord.findUnique({ where: { orderId } })).toBeNull();
    expect((await raw.uploadedAsset.findUniqueOrThrow({ where: { id: staleAsset } })).status)
      .toBe("PENDING_DELETE");
  });

  it("R10-PG-04: cleanup transaction wins a genuine asset-row lock race; handover write rolls back", async () => {
    const orderId = await fixtureOrder();
    const assetId = await fixtureAsset(renterId);

    let signalLocked!: (pid: number) => void;
    const assetLocked = new Promise<number>((resolve) => { signalLocked = resolve; });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });

    // Cleanup T1 acquires the real UploadedAsset row lock, updates to
    // PENDING_DELETE, then holds the uncommitted row while the Server Action
    // reaches its CAS update. Same conditional UPDATE shape as cleanup.
    const cleanupTx = raw.$transaction(async (tx) => {
      const changed = await tx.uploadedAsset.updateMany({
        where: { id: assetId, status: "UPLOADED" },
        data: { status: "PENDING_DELETE" },
      });
      expect(changed.count).toBe(1);
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      signalLocked(pid);
      await cleanupGate;
    }, { timeout: 10_000 });

    const blockerPid = await assetLocked;
    const actionPromise = submit(orderId, assetId);

    // Deterministic lock barrier scoped to this cleanup transaction backend.
    // Waits caused by other concurrently executing Vitest files cannot match.
    let observedWait = false;
    try {
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        const rows = await raw.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity a
            WHERE a.wait_event_type = 'Lock'
              AND ${blockerPid} = ANY(pg_blocking_pids(a.pid))
          ) AS waiting
        `;
        if (rows[0]?.waiting) { observedWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      releaseCleanup();
    }

    const [result] = await Promise.all([actionPromise, cleanupTx.then(() => undefined)]);
    expect(observedWait).toBe(true);
    expect(result.success).toBe(false);
    expect(result.message).toContain("照片状态已变化");
    expect(await raw.rentalHandoverRecord.findUnique({ where: { orderId } })).toBeNull();
    const order = await raw.rentalOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PENDING_PICKUP");
    const asset = await raw.uploadedAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.status).toBe("PENDING_DELETE");
    expect(asset.rentalOrderId).toBeNull();
  });

  it("R10-PG-03: successful pickup persists handover reference and ATTACHED private asset in the same commit", async () => {
    const orderId = await fixtureOrder();
    const assetId = await fixtureAsset(renterId);
    const result = await submit(orderId, assetId);
    expect(result).toMatchObject({ success: true });
    const record = await raw.rentalHandoverRecord.findUniqueOrThrow({ where: { orderId } });
    expect(record.photos).toEqual(["asset:" + assetId]);
    expect(record.renterConfirmed).toBe(true);
    expect(record.ownerConfirmed).toBe(false);
    const asset = await raw.uploadedAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.status).toBe("ATTACHED");
    expect(asset.rentalOrderId).toBe(orderId);
    expect(asset.access).toBe("PRIVATE");
  });
});
