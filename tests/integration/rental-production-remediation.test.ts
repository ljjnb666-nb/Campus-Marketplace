import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient, type Prisma, type RentalOrderStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildLiveDomainEventProjectionDedupeKey } from "@/lib/analytics/projection-contract";

// No DAO/domain/lock mocks. Fixtures use raw Prisma; mutations use the production
// transaction extensions, lifecycle guard, row locks, event writer and outbox.
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!databaseUrl)("rental production remediation (real PostgreSQL)", () => {
  let raw: PrismaClient;
  let domain: typeof import("@/lib/rental-order-machine");
  let run: typeof import("@/lib/prisma").withTransaction;
  let campusId = "";
  let categoryId = "";
  let listingId = "";
  let ownerId = "";
  let renterId = "";
  const tag = `rental-remediation-${randomUUID()}`;

  beforeAll(async () => {
    // Both clients must target the same explicitly selected integration DB.
    expect(process.env.DATABASE_URL).toBe(databaseUrl);
    raw = new PrismaClient({ datasourceUrl: databaseUrl });
    domain = await import("@/lib/rental-order-machine");
    ({ withTransaction: run } = await import("@/lib/prisma"));
    campusId = (await raw.campus.create({ data: { name: tag, slug: tag, schoolName: "测试大学" } })).id;
    categoryId = (await raw.rentalCategory.create({ data: { name: tag, slug: tag } })).id;
    const users = await Promise.all(["owner", "renter"].map(role => raw.user.create({ data: {
      name: role, email: `${tag}-${role}@it.local`, passwordHash: "test-only", schoolName: "测试大学",
      campusId, status: "ACTIVE",
    } })));
    [ownerId, renterId] = users.map(user => user.id);
    await raw.campusMembership.createMany({ data: users.map(user => ({ userId: user.id, campusId, status: "ACTIVE" })) });
    listingId = (await raw.rentalListing.create({ data: {
      title: tag, description: "isolated regression fixture", ownerId, categoryId, campusId,
      condition: "NEW", price: "20", pricingUnit: "PER_DAY", depositAmount: "50",
      minimumDuration: 1, maximumDuration: 30, pickupLocation: "南门", returnLocation: "南门",
    } })).id;
  });

  afterAll(async () => {
    if (!raw) return;
    if (campusId) {
      const events = await raw.domainEvent.findMany({ where: { campusId }, select: { id: true } });
      const eventIds = events.map(event => event.id);
      await raw.metricContribution.deleteMany({ where: { eventId: { in: eventIds } } });
      await raw.projectionReceipt.deleteMany({ where: { eventId: { in: eventIds } } });
      await raw.asyncJob.deleteMany({ where: { dedupeKey: { in: eventIds.map(buildLiveDomainEventProjectionDedupeKey) } } });
      await raw.domainEvent.deleteMany({ where: { campusId } });
      await raw.dataHold.deleteMany({ where: { subjectId: { in: [ownerId, renterId] } } });
      await raw.notification.deleteMany({ where: { userId: { in: [ownerId, renterId] } } });
      await raw.rentalOrder.deleteMany({ where: { rentalListingId: listingId } });
      await raw.rentalListing.deleteMany({ where: { id: listingId } });
      await raw.rentalCategory.deleteMany({ where: { id: categoryId } });
      await raw.campusMembership.deleteMany({ where: { campusId } });
      await raw.user.deleteMany({ where: { campusId } });
      await raw.campus.delete({ where: { id: campusId } });
      expect(await raw.campus.count({ where: { id: campusId } })).toBe(0);
    }
    await raw.$disconnect();
  });

  async function order(status: RentalOrderStatus = "PENDING_RETURN") {
    return raw.rentalOrder.create({ data: {
      orderNumber: randomUUID(), rentalListingId: listingId, ownerId, renterId, status,
      startTime: new Date("2026-10-20T00:00:00Z"), endTime: new Date("2026-10-21T00:00:00Z"),
      unitPriceSnapshot: "20", pricingUnitSnapshot: "PER_DAY", rentalDuration: 1,
      rentalAmount: "20", depositAmount: "50", finalAmount: "70", paymentStatus: "OFFLINE_PENDING",
      depositStatus: "OFFLINE_UNVERIFIED", pickupLocationSnapshot: "南门", returnLocationSnapshot: "南门",
    } });
  }

  const clean = { photos: [], hasDamage: false, needsCleaning: false, accessoriesComplete: true };
  const ownerReturn = (orderId: string, extra = {}) => run(tx => domain.confirmReturnTx(tx, {
    orderId, userId: ownerId, role: "owner", ...clean, ...extra,
  }));
  const claimInput = (orderId: string) => ({ orderId, userId: ownerId,
    damageDescription: "壳体损坏", requestedDeduction: "12.50", photos: ["asset:claim"] });
  const eventsFor = (orderId: string) => raw.domainEvent.count({ where: { aggregateId: orderId } });
  const notificationsFor = (orderId: string) => raw.notification.count({ where: {
    userId: { in: [ownerId, renterId] }, payload: { path: ["orderId"], equals: orderId },
  } });
  async function counts() {
    const owner = await raw.user.findUniqueOrThrow({ where: { id: ownerId } });
    const renter = await raw.user.findUniqueOrThrow({ where: { id: renterId } });
    return [owner.rentalOwnerCount, renter.rentalRenterCount];
  }

  // Observe the specific backend wait edge, not timing/sleep ordering or any
  // other concurrently running test's advisory/row lock.
  async function waitForBlock(waiter: number, blocker: number) {
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      const [row] = await raw.$queryRaw<{ blocked: boolean }[]>`
        SELECT ${blocker}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`;
      if (row.blocked) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }

  async function winnerBeforeLoser(
    winner: (tx: Prisma.TransactionClient) => Promise<unknown>,
    loser: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    const winnerReady = deferred<number>();
    const waiterReady = deferred<number>();
    const release = deferred<void>();
    const winning = run(async tx => {
      const result = await winner(tx);
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      winnerReady.resolve(row.pid);
      await release.promise;
      return result;
    });
    const blocker = await winnerReady.promise;
    const losing = run(async tx => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      waiterReady.resolve(row.pid);
      return loser(tx);
    });
    let blocked = false;
    let results: unknown[] = [];
    try { blocked = await waitForBlock(await waiterReady.promise, blocker); }
    finally {
      release.resolve();
      results = await Promise.all([winning, losing]);
    }
    expect(blocked).toBe(true);
    expect(results[0]).toEqual({ success: true });
    expect(results[1]).toHaveProperty("error");
  }

  it.each(["approve", "reject"] as const)("cancel commits while cross-actor %s waits; no resurrection or side effects", async action => {
    const created = await order("PENDING_APPROVAL");
    const before = await counts();
    await winnerBeforeLoser(
      tx => domain.cancelRentalOrderTx(tx, { orderId: created.id, userId: renterId, cancellationReason: "OTHER" }),
      tx => action === "approve" ? domain.approveRentalOrderTx(tx, { orderId: created.id, userId: ownerId })
        : domain.rejectRentalOrderTx(tx, { orderId: created.id, userId: ownerId, rejectReason: "暂不出租" }),
    );
    const current = await raw.rentalOrder.findUniqueOrThrow({ where: { id: created.id }, include: { statusLogs: true } });
    expect(current.status).toBe("CANCELLED");
    expect(current.statusLogs.map(log => log.toStatus)).toEqual(["CANCELLED"]);
    expect(await notificationsFor(created.id)).toBe(1);
    expect(await eventsFor(created.id)).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it("parallel pickup preserves both immutable evidence submissions", async () => {
    const created = await order("PENDING_PICKUP");
    expect(await Promise.all([
      run(tx => domain.confirmPickupTx(tx, { orderId: created.id, userId: ownerId, role: "owner", photos: ["asset:owner"], currentCondition: "owner condition", knownIssues: "owner issue" })),
      run(tx => domain.confirmPickupTx(tx, { orderId: created.id, userId: renterId, role: "renter", photos: ["asset:renter"], currentCondition: "renter condition", knownIssues: "renter issue" })),
    ])).toEqual([{ success: true }, { success: true }]);
    const record = await raw.rentalHandoverRecord.findUniqueOrThrow({ where: { orderId: created.id } });
    expect(record).toMatchObject({ ownerPhotos: ["asset:owner"], renterPhotos: ["asset:renter"],
      ownerCurrentCondition: "owner condition", renterCurrentCondition: "renter condition",
      ownerKnownIssues: "owner issue", renterKnownIssues: "renter issue", currentCondition: null, knownIssues: null,
      ownerConfirmedAt: expect.any(Date), renterConfirmedAt: expect.any(Date) });
    expect([...record.photos].sort()).toEqual(["asset:owner", "asset:renter"]);
    expect(await run(tx => domain.confirmPickupTx(tx, { orderId: created.id, userId: ownerId, role: "owner", photos: [] }))).toHaveProperty("error");
    expect(await raw.rentalHandoverRecord.findUnique({ where: { orderId: created.id } })).toEqual(record);
    expect((await raw.rentalOrder.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("IN_RENTAL");
    expect(await notificationsFor(created.id)).toBe(2);
  });

  it("owner damage inspection survives later renter denial and actor retries", async () => {
    const created = await order();
    expect(await ownerReturn(created.id, { photos: ["asset:owner-damage"], hasDamage: true, inspectionNote: "owner scratch" })).toEqual({ success: true });
    expect(await run(tx => domain.confirmReturnTx(tx, { orderId: created.id, userId: renterId, role: "renter", ...clean,
      photos: ["asset:renter-clean"], inspectionNote: "renter disagrees" }))).toEqual({ success: true });
    const record = await raw.rentalReturnRecord.findUniqueOrThrow({ where: { orderId: created.id } });
    expect(record).toMatchObject({ hasDamage: true, inspectionNote: "owner scratch", ownerPhotos: ["asset:owner-damage"],
      renterHasDamage: false, renterInspectionNote: "renter disagrees", renterPhotos: ["asset:renter-clean"],
      ownerConfirmedAt: expect.any(Date), ownerInspectionRecordedAt: expect.any(Date), renterConfirmedAt: expect.any(Date) });
    expect(await ownerReturn(created.id)).toHaveProperty("error");
    expect(await run(tx => domain.confirmReturnTx(tx, { orderId: created.id, userId: renterId, role: "renter", ...clean }))).toHaveProperty("error");
    expect(await raw.rentalReturnRecord.findUnique({ where: { orderId: created.id } })).toEqual(record);
    expect((await raw.rentalOrder.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("PENDING_INSPECTION");
    expect(await eventsFor(created.id)).toBe(0);
  });

  it("migration snapshot preserves legacy renter-first evidence when owner submits after upgrade", async () => {
    const created = await order();
    const record = await raw.rentalReturnRecord.create({ data: { orderId: created.id, photos: ["asset:legacy"],
      renterConfirmed: true, renterConfirmedAt: new Date(), hasDamage: true, needsCleaning: true,
      accessoriesComplete: false, inspectionNote: "legacy shared statement" } });
    // Execute the real migration's backfill DML, limited to our fixture. The
    // companion migration suite executes all DDL/DML in an isolated schema.
    const migration = readFileSync(join("prisma", "migrations", "202610250001_rental_legacy_inspection_snapshot", "migration.sql"), "utf8");
    const backfill = migration.slice(migration.indexOf('UPDATE "RentalReturnRecord"'))
      .replace('WHERE "ownerInspectionRecordedAt" IS NULL;', 'WHERE "ownerInspectionRecordedAt" IS NULL AND "id" = $1;');
    expect(await raw.$executeRawUnsafe(backfill, record.id)).toBe(1);
    expect(await ownerReturn(created.id, { inspectionNote: "new owner clean inspection", photos: ["asset:new-owner"] })).toEqual({ success: true });
    const current = await raw.rentalReturnRecord.findUniqueOrThrow({ where: { orderId: created.id } });
    expect(current).toMatchObject({ ownerInspectionRecordedAt: expect.any(Date), hasDamage: false,
      inspectionNote: "new owner clean inspection", legacyInspectionNote: "legacy shared statement",
      legacyHasDamage: true, legacyNeedsCleaning: true, legacyAccessoriesComplete: false });
    expect(current.photos).toEqual(["asset:legacy", "asset:new-owner"]);
  });

  it.each([{ needsCleaning: true }, { accessoriesComplete: false }])("non-damage inspection issue %j stays reviewable and can close without compensation", async issue => {
    const created = await order();
    expect(await ownerReturn(created.id, issue)).toEqual({ success: true });
    expect((await raw.rentalOrder.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("PENDING_INSPECTION");
    expect(await run(tx => domain.completeRentalInspectionTx(tx, { orderId: created.id, userId: renterId }))).toHaveProperty("error");
    const before = await counts();
    expect(await run(tx => domain.completeRentalInspectionTx(tx, { orderId: created.id, userId: ownerId }))).toEqual({ success: true });
    expect(await run(tx => domain.completeRentalInspectionTx(tx, { orderId: created.id, userId: ownerId }))).toHaveProperty("error");
    expect(await counts()).toEqual(before.map(value => value + 1));
    expect(await eventsFor(created.id)).toBe(2);
    expect((await raw.rentalOrder.findUniqueOrThrow({ where: { id: created.id } })).depositStatus).toBe("OFFLINE_UNVERIFIED");
  });

  it("duplicate concurrent claims converge to one pending claim, including DB uniqueness", async () => {
    const created = await order("PENDING_INSPECTION");
    const results = await Promise.all([run(tx => domain.submitDamageClaimTx(tx, claimInput(created.id))), run(tx => domain.submitDamageClaimTx(tx, claimInput(created.id)))]);
    expect(results.filter(result => "success" in result)).toHaveLength(1);
    expect(results.filter(result => "error" in result)).toHaveLength(1);
    expect(await raw.rentalDamageClaim.count({ where: { orderId: created.id, resolvedAt: null, supersededAt: null } })).toBe(1);
    await expect(raw.rentalDamageClaim.create({ data: { orderId: created.id, submittedById: ownerId,
      damageDescription: "bypass attempt", requestedDeduction: "1", photos: [] } })).rejects.toMatchObject({ code: "P2002" });
    expect(await run(tx => domain.completeRentalInspectionTx(tx, { orderId: created.id, userId: ownerId }))).toHaveProperty("error");
    expect(await notificationsFor(created.id)).toBe(1);
  });

  it.each([true, false])("claim response agreed=%s completes exactly once without inventing money movement", async agreed => {
    const created = await order("PENDING_INSPECTION");
    expect(await run(tx => domain.submitDamageClaimTx(tx, claimInput(created.id)))).toEqual({ success: true });
    const claim = await raw.rentalDamageClaim.findFirstOrThrow({ where: { orderId: created.id } });
    const before = await counts();
    const results = await Promise.all([1, 2].map(() => run(tx => domain.respondDamageClaimTx(tx, { claimId: claim.id, userId: renterId, agreed }))));
    expect(results.filter(result => "success" in result)).toHaveLength(1);
    expect(results.filter(result => "error" in result)).toHaveLength(1);
    const current = await raw.rentalOrder.findUniqueOrThrow({ where: { id: created.id } });
    expect(current).toMatchObject({ status: "COMPLETED", paymentStatus: "OFFLINE_PENDING", depositStatus: "OFFLINE_UNVERIFIED" });
    expect(current.depositDeduction.toString()).toBe("0");
    const updated = await raw.rentalDamageClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updated.approvedDeduction?.toString()).toBe(agreed ? "12.5" : "0");
    expect(updated.renterAgreed).toBe(agreed);
    expect(await counts()).toEqual(before.map(value => value + 1));
    expect(await eventsFor(created.id)).toBe(2);
    expect(await notificationsFor(created.id)).toBe(2);
    expect(await raw.rentalOrderStatusLog.count({ where: { orderId: created.id, toStatus: "COMPLETED" } })).toBe(1);
  });

  it.each(["return", "request", "submit-claim", "respond-claim"] as const)("actual dispute transaction wins against %s; waiter reads fresh status", async action => {
    const created = await order(action === "request" ? "IN_RENTAL" : action === "return" ? "PENDING_RETURN" : "PENDING_INSPECTION");
    let claimId = "";
    if (action === "respond-claim") {
      await run(tx => domain.submitDamageClaimTx(tx, claimInput(created.id)));
      claimId = (await raw.rentalDamageClaim.findFirstOrThrow({ where: { orderId: created.id } })).id;
    }
    const before = await counts();
    await winnerBeforeLoser(
      tx => domain.initiateDisputeTx(tx, { orderId: created.id, userId: renterId, reason: "真实纠纷并发测试", evidencePhotos: [] }),
      tx => action === "return" ? domain.confirmReturnTx(tx, { orderId: created.id, userId: ownerId, role: "owner", ...clean })
        : action === "request" ? domain.requestReturnTx(tx, { orderId: created.id, userId: renterId })
        : action === "submit-claim" ? domain.submitDamageClaimTx(tx, claimInput(created.id))
        : domain.respondDamageClaimTx(tx, { claimId, userId: renterId, agreed: true }),
    );
    expect((await raw.rentalOrder.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("IN_DISPUTE");
    expect(await raw.rentalReturnRecord.count({ where: { orderId: created.id } })).toBe(0);
    expect(await eventsFor(created.id)).toBe(0);
    expect(await counts()).toEqual(before);
    if (claimId) expect((await raw.rentalDamageClaim.findUniqueOrThrow({ where: { id: claimId } })).resolvedAt).toBeNull();
    else expect(await raw.rentalDamageClaim.count({ where: { orderId: created.id } })).toBe(0);
  });

  it("completion rollback removes evidence, status, logs, events, outbox, counters and notifications together", async () => {
    const created = await order();
    const before = await counts();
    await expect(run(async tx => {
      expect(await domain.confirmReturnTx(tx, { orderId: created.id, userId: ownerId, role: "owner", ...clean })).toEqual({ success: true });
      throw new Error("force-completion-rollback");
    })).rejects.toThrow("force-completion-rollback");
    expect((await raw.rentalOrder.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("PENDING_RETURN");
    expect(await raw.rentalReturnRecord.count({ where: { orderId: created.id } })).toBe(0);
    expect(await raw.rentalOrderStatusLog.count({ where: { orderId: created.id } })).toBe(0);
    expect(await eventsFor(created.id)).toBe(0);
    expect(await notificationsFor(created.id)).toBe(0);
    expect(await counts()).toEqual(before);
    expect(await ownerReturn(created.id)).toEqual({ success: true });
    expect(await ownerReturn(created.id)).toHaveProperty("error");
    expect(await counts()).toEqual(before.map(value => value + 1));
    expect(await eventsFor(created.id)).toBe(2);
  });
});
