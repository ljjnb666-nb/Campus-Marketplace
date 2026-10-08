import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordCompletedSearchTx } from "@/lib/analytics/search-telemetry";

const url = process.env.INTEGRATION_DATABASE_URL;
describe.skipIf(!url)("10K-R2a PostgreSQL search count atomicity", () => {
  let db: PrismaClient;
  const hours = [
    new Date("2030-01-01T01:00:00.000Z"),
    new Date("2030-01-01T02:00:00.000Z"),
    new Date("2030-01-01T03:00:00.000Z"),
  ];
  const digests: string[] = [];
  const digest = () => {
    const key = randomBytes(32).toString("hex");
    digests.push(key);
    return key;
  };
  const params = (key: string, hour: Date, zero = false) => ({
    digest: key, zero, hourStart: hour, now: new Date(hour.getTime() + 25_000),
  });
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
    await db.$connect();
  });
  afterAll(async () => {
    if (!db) return;
    await db.searchTelemetryClaim.deleteMany({ where: { digest: { in: digests } } });
    await db.searchTelemetryHour.deleteMany({ where: { hourStart: { in: hours } } });
    await db.$disconnect();
  });

  it("counts one true success across concurrent identical POST claims", async () => {
    const key = digest();
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      db.$transaction(tx => recordCompletedSearchTx(tx, params(key, hours[0], true)))
    ));
    expect(results.filter(x => x === "RECORDED")).toHaveLength(1);
    expect(results.filter(x => x === "DUPLICATE")).toHaveLength(7);
    const bucket = await db.searchTelemetryHour.findUniqueOrThrow({
      where: { hourStart: hours[0] },
    });
    expect(bucket.attempts).toBe(1n);
    expect(bucket.zeroResults).toBe(1n);
    expect(await db.searchTelemetryClaim.count({ where: { digest: key } })).toBe(1);
  });

  it("distinct concurrent attempts atomically increment the same global bucket", async () => {
    const keys = Array.from({ length: 8 }, () => digest());
    const rows = await Promise.all(keys.map((key, index) =>
      db.$transaction(tx => recordCompletedSearchTx(tx, params(key, hours[1], index % 2 === 0)))
    ));
    expect(rows.every(row => row === "RECORDED")).toBe(true);
    const bucket = await db.searchTelemetryHour.findUniqueOrThrow({
      where: { hourStart: hours[1] },
    });
    expect(bucket.attempts).toBe(8n);
    expect(bucket.zeroResults).toBe(4n);
  });

  it("transaction rollback cannot leave an orphan claim or count", async () => {
    const key = digest();
    await expect(db.$transaction(async tx => {
      await recordCompletedSearchTx(tx, params(key, hours[2], true));
      throw new Error("ROLLBACK_FIXTURE");
    })).rejects.toThrow("ROLLBACK_FIXTURE");
    expect(await db.searchTelemetryClaim.count({ where: { digest: key } })).toBe(0);
    expect(await db.searchTelemetryHour.count({ where: { hourStart: hours[2] } })).toBe(0);
  });
});
