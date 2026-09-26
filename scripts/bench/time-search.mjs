/**
 * FINAL REPAIR A — 搜索分查询计时探针（benchmark-only）。
 * 用法：node scripts/bench/time-search.mjs <keyword>（DATABASE_URL 指向 campus_perf）
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const kw = process.argv[2];
const contains = { contains: kw, mode: "insensitive" };
const modFilter = { moderations: { none: { resolvedAt: null } } };

async function t(name, fn) {
  const t0 = process.hrtime.bigint();
  const rows = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${name}: ${ms.toFixed(1)}ms rows=${Array.isArray(rows) ? rows.length : rows}`);
}

await t("products", () =>
  prisma.product.findMany({
    where: {
      deletedAt: null,
      status: "ACTIVE",
      ...modFilter,
      OR: [{ title: contains }, { description: contains }, { locationText: contains }],
    },
    include: {
      category: true,
      seller: { select: { id: true, name: true } },
      images: { orderBy: { sortOrder: "asc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
    take: 12,
  }));
await t("errands", () =>
  prisma.errandTask.findMany({
    where: {
      deletedAt: null,
      status: { in: ["OPEN", "CLAIMED", "IN_PROGRESS", "PENDING_CONFIRMATION"] },
      ...modFilter,
      OR: [
        { title: contains },
        { description: contains },
        { pickupLocation: contains },
        { deliveryLocation: contains },
      ],
    },
    include: { publisher: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 12,
  }));
await t("services", () =>
  prisma.serviceListing.findMany({
    where: {
      deletedAt: null,
      status: "ACTIVE",
      ...modFilter,
      OR: [{ title: contains }, { description: contains }, { locationText: contains }],
    },
    include: { provider: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 12,
  }));
await t("users", () =>
  prisma.user.findMany({
    where: {
      deletedAt: null,
      status: "ACTIVE",
      OR: [{ name: contains }, { schoolName: contains }, { college: contains }, { bio: contains }],
    },
    select: {
      id: true,
      name: true,
      bio: true,
      schoolName: true,
      positiveReviewRate: true,
      completedOrdersCount: true,
      campus: { select: { id: true, name: true } },
    },
    orderBy: { completedOrdersCount: "desc" },
    take: 12,
  }));
await prisma.$disconnect();
