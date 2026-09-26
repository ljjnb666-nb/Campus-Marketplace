/**
 * FINAL REPAIR A — 性能基线造数脚本（benchmark-only，不进入生产路径）。
 *
 * 目标：在一个真实 PostgreSQL 数据库上重建足以暴露 planner 行为的数据规模，
 * 供 LR-010/012/013 的 EXPLAIN 与 load-test 基线复用（BEFORE/AFTER 使用同一
 * 数据集）。通过 prisma migrate deploy 建表后运行本脚本。
 *
 * 用法：
 *   DATABASE_URL="postgresql://.../campus_perf?schema=public" node scripts/bench/seed-perf.mjs
 *
 * 数据规模（默认）：
 *   Campus 3, ProductCategory 8, ErrandCategory 6, ServiceCategory 6,
 *   RentalCategory 5, User 5,000, Product 120,000, ProductImage 120,000,
 *   ErrandTask 60,000, ServiceListing 40,000, RentalListing 20,000,
 *   ListingModeration 450（150 active + 300 resolved）。
 *   合计 ~365k 行。
 *
 * 分布设计（记录于脚本内，禁止只造高选择性关键词制造虚假好结果）：
 *   - 搜索词分四级选择性（Product.title）：数码 ≈20%、自行车 ≈5%、台灯 ≈2%、
 *     考研 ≈1%、吉他 ≈0.4%、midi键盘 ≈0.05%；description 另有独立词
 *     （急出/可小刀/考研真题），保证 title 命中与 description 命中是不同计划。
 *   - favoriteCount 呈重尾：70% [0,3]、20% [4,20]、9% [21,100]、1% [101,999]，
 *     使 popular 排序的 Top-N 不是全表同值。
 *   - createdAt 均匀铺开 180 天；price 对数均匀 5..5000。
 *   - status：Product ACTIVE 90% / SOLD 5% / RESERVED 3% / OFFLINE 2%；
 *     deletedAt 2% 独立抽样。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── 可复现随机数（同脚本同分布；避免每次造数分布漂移）──
let seed = 0x2f6e2b1;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
}
function randInt(min, max) {
  return min + Math.floor(rnd() * (max - min + 1));
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}
function pickWeighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r < 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

const BATCH = 2000;

async function insertBatched(model, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await model.createMany({ data: rows.slice(i, i + BATCH), skipDuplicates: false });
  }
}

function pad(n, width) {
  return String(n).padStart(width, "0");
}

// ── 词表（分级选择性）──
const PRODUCT_NOUNS = [
  { w: 20, term: "数码" }, { w: 5, term: "自行车" }, { w: 2, term: "台灯" },
  { w: 1, term: "考研" }, { w: 0.4, term: "吉他" }, { w: 0.05, term: "midi键盘" },
];
const COMMON_NOUNS = ["水杯", "雨伞", "台式风扇", "英语真题", "椅子", "书架", "书包", "耳机", "充电宝", "键盘", "鼠标", "床垫", "衣架", "镜子", "收纳箱", "篮球", "足球", "羽毛球拍", "滑板", "筷子"];
function productNoun() {
  return pickWeighted([
    ...PRODUCT_NOUNS.map((n) => [n.term, n.w]),
    [pick(COMMON_NOUNS), 71.55],
  ]);
}
const PRODUCT_ADJ = ["九成新", "几乎全新", "95新", "自用", "宿舍闲置", "毕业出", "急出", "全新未拆", "微瑕", "可小刀"];
const PRODUCT_SUFFIX = [" 26寸", " 学生款", " 便携版", " 带发票", " 可自提", " 含运费", " 限校园面交", ""];
const DESCRIPTION_TAILS = [
  "急出可小刀，诚心要的联系我。", "考研真题笔记附赠，先到先得。",
  "宿舍楼下自提优先，可送到快递站。", "功能完好无维修，附带原装配件。",
  "低价转让，可议价幅度小。", "毕业清仓，全部打包出。",
];

const ERRAND_TITLES = ["代取快递", "代买午饭", "代排队取号", "拼车回校区", "代寄包裹", "图书馆占座", "代打文件", "代拿外卖"];
const LOCATIONS = ["紫荆1号楼", "紫荆5号楼", "桃李园食堂", "东门快递站", "图书馆北门", "南门超市", "教学楼A栋", "实验楼B栋", "西区篮球场", "研究生公寓2栋"];
const SCHOOLS = ["某某大学", "某某理工大学", "某某师范大学", "某某财经大学", "某某医科大学"];
const COLLEGES = ["计算机学院", "外国语学院", "机械工程学院", "经济管理学院", "生命科学学院", "法学院", "新闻传播学院", "数学学院", "艺术学院", "化学学院"];
const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "黄", "赵", "周", "吴", "徐", "孙", "马", "朱", "胡", "郭", "何", "林", "罗", "郑"];
const GIVEN = ["明", "华", "芳", "静", "磊", "洋", "勇", "艳", "杰", "涛", "婷", "雪", "欣", "怡", "泽", "宇", "浩", "睿", "琪", "晨"];
const BIOS = ["热爱运动和阅读，靠谱靠谱。", "数码爱好者，闲置出清。", "考研上岸，资料出清中。", "宿舍茶话会组织者。", null, null];
const SERVICE_TITLES = ["PPT代做美化", "海报设计", "钢琴陪练", "家教辅导", "摄影修图", "电脑装机维修", "论文格式排版", "视频剪辑", "翻译润色", "宠物寄养"];

function favoriteCount() {
  return pickWeighted([
    [randInt(0, 3), 70],
    [randInt(4, 20), 20],
    [randInt(21, 100), 9],
    [randInt(101, 999), 1],
  ]);
}
function completedOrderCount() {
  return pickWeighted([
    [randInt(0, 2), 60],
    [randInt(3, 20), 30],
    [randInt(21, 100), 9],
    [randInt(101, 500), 1],
  ]);
}
function price5to5000() {
  // 对数均匀：5..5000
  const u = rnd();
  return Math.round((5 * Math.pow(1000, u)) * 100) / 100;
}
function createdAtWithin180d() {
  return new Date(Date.now() - Math.floor(rnd() * 180 * 24 * 3600 * 1000) - randInt(0, 3600) * 1000);
}

async function main() {
  const t0 = Date.now();
  console.log("[seed-perf] 清空业务表…");
  await prisma.$executeRawUnsafe(
    `TRUNCATE "ListingModeration", "ProductImage", "RentalListing", "ServiceListing", "ErrandTask",
     "Product", "User", "ProductCategory", "ErrandCategory", "ServiceCategory", "RentalCategory",
     "Campus" CASCADE`,
  );

  console.log("[seed-perf] campuses / categories…");
  const campuses = [];
  for (let i = 0; i < 3; i++) {
    campuses.push({
      id: `bcampus${pad(i, 3)}`,
      name: `主校区${i + 1}号`,
      slug: `main-campus-${i + 1}`,
      schoolName: SCHOOLS[i % SCHOOLS.length],
      isActive: true,
    });
  }
  await prisma.campus.createMany({ data: campuses });
  const campusIds = campuses.map((c) => c.id);

  const productCats = [];
  for (let i = 0; i < 8; i++) {
    productCats.push({ id: `bpcat${pad(i, 3)}`, name: `分类${i + 1}`, slug: `cat-${i + 1}`, sortOrder: i });
  }
  await prisma.productCategory.createMany({ data: productCats });
  const errandCats = [];
  for (let i = 0; i < 6; i++) {
    errandCats.push({ id: `becat${pad(i, 3)}`, name: `跑腿${i + 1}`, slug: `errand-${i + 1}`, sortOrder: i });
  }
  await prisma.errandCategory.createMany({ data: errandCats });
  const serviceCats = [];
  for (let i = 0; i < 6; i++) {
    serviceCats.push({ id: `bscat${pad(i, 3)}`, name: `服务${i + 1}`, slug: `service-${i + 1}`, sortOrder: i });
  }
  await prisma.serviceCategory.createMany({ data: serviceCats });
  const rentalCats = [];
  for (let i = 0; i < 5; i++) {
    rentalCats.push({ id: `brcat${pad(i, 3)}`, name: `租赁${i + 1}`, slug: `rental-${i + 1}`, sortOrder: i });
  }
  await prisma.rentalCategory.createMany({ data: rentalCats });

  console.log("[seed-perf] users × 5000…");
  const users = [];
  for (let i = 0; i < 5000; i++) {
    users.push({
      id: `buser${pad(i, 6)}`,
      name: `${pick(SURNAMES)}${pick(GIVEN)}${pick(GIVEN)}`,
      email: `bench-user-${pad(i, 6)}@bench.local`,
      passwordHash: "$2a$10$benchbenchbenchbenchbenchbenchbenchbenchbenchbenchb",
      schoolName: pick(SCHOOLS),
      college: pick(COLLEGES),
      bio: pick(BIOS),
      status: "ACTIVE",
      campusId: pick(campusIds),
      completedOrdersCount: completedOrderCount(),
      positiveReviewRate: Math.round((0.8 + rnd() * 0.2) * 100) / 100,
      verificationStatus: pickWeighted([["VERIFIED", 30], ["UNVERIFIED", 70]]),
    });
  }
  await insertBatched(prisma.user, users);
  const userIds = users.map((u) => u.id);

  console.log("[seed-perf] products × 120000…");
  const products = [];
  const now = Date.now();
  for (let i = 0; i < 120000; i++) {
    const fav = favoriteCount();
    const status = pickWeighted([["ACTIVE", 90], ["SOLD", 5], ["RESERVED", 3], ["OFFLINE", 2]]);
    const created = createdAtWithin180d();
    products.push({
      id: `bprod${pad(i, 7)}`,
      title: `${pick(PRODUCT_ADJ)}${productNoun()}${pick(PRODUCT_SUFFIX)}`,
      description: `${pick(PRODUCT_ADJ)}${productNoun()}，${pick(DESCRIPTION_TAILS)}`,
      price: price5to5000(),
      locationText: pick(LOCATIONS),
      condition: pickWeighted([["LIKE_NEW", 40], ["LIGHTLY_USED", 35], ["NORMAL_USED", 20], ["NEW", 5]]),
      status,
      viewCount: fav * 8 + randInt(10, 300),
      favoriteCount: fav,
      sellerId: pick(userIds),
      campusId: pick(campusIds),
      categoryId: pick(productCats).id,
      createdAt: created,
      updatedAt: created,
      deletedAt: rnd() < 0.02 ? new Date(now - randInt(1, 90) * 86400000) : null,
    });
  }
  await insertBatched(prisma.product, products);

  console.log("[seed-perf] product images × 120000…");
  const images = products.map((p, i) => ({
    id: `bimg${pad(i, 7)}`,
    productId: p.id,
    url: "/uploads/placeholders/product-cover.svg",
    sortOrder: 0,
  }));
  await insertBatched(prisma.productImage, images);

  console.log("[seed-perf] errand tasks × 60000…");
  const errands = [];
  for (let i = 0; i < 60000; i++) {
    const created = createdAtWithin180d();
    errands.push({
      id: `berr${pad(i, 7)}`,
      title: `${pick(ERRAND_TITLES)} ${pick(LOCATIONS)}`,
      description: `${pick(ERRAND_TITLES)}，${pick(DESCRIPTION_TAILS)}`,
      categoryId: pick(errandCats).id,
      reward: Math.round((2 + rnd() * 50) * 100) / 100,
      pickupLocation: pick(LOCATIONS),
      deliveryLocation: pick(LOCATIONS),
      deadline: new Date(now + (rnd() < 0.2 ? -randInt(1, 3) : randInt(0, 14)) * 86400000),
      status: pickWeighted([["OPEN", 60], ["CLAIMED", 10], ["IN_PROGRESS", 10], ["PENDING_CONFIRMATION", 5], ["COMPLETED", 15]]),
      publisherId: pick(userIds),
      campusId: pick(campusIds),
      createdAt: created,
      updatedAt: created,
      deletedAt: rnd() < 0.02 ? new Date(now - randInt(1, 90) * 86400000) : null,
    });
  }
  await insertBatched(prisma.errandTask, errands);

  console.log("[seed-perf] service listings × 40000…");
  const services = [];
  for (let i = 0; i < 40000; i++) {
    const created = createdAtWithin180d();
    const completed = completedOrderCount();
    services.push({
      id: `bsvc${pad(i, 7)}`,
      title: `${pick(SERVICE_TITLES)} ${pick(SCHOOLS)}`,
      description: `${pick(SERVICE_TITLES)}，${pick(DESCRIPTION_TAILS)}`,
      categoryId: pick(serviceCats).id,
      price: price5to5000(),
      pricingUnit: pickWeighted([["PER_HOUR", 50], ["PER_ORDER", 40], ["PER_SESSION", 10]]),
      locationText: pick(LOCATIONS),
      status: pickWeighted([["ACTIVE", 90], ["PAUSED", 5], ["OFFLINE", 5]]),
      completedOrderCount: completed,
      averageRating: Math.round((3 + rnd() * 2) * 10) / 10,
      providerId: pick(userIds),
      campusId: pick(campusIds),
      createdAt: created,
      updatedAt: created,
      deletedAt: rnd() < 0.02 ? new Date(now - randInt(1, 90) * 86400000) : null,
    });
  }
  await insertBatched(prisma.serviceListing, services);

  console.log("[seed-perf] rental listings × 20000…");
  const rentals = [];
  for (let i = 0; i < 20000; i++) {
    const created = createdAtWithin180d();
    const fav = favoriteCount();
    rentals.push({
      id: `brent${pad(i, 7)}`,
      ownerId: pick(userIds),
      categoryId: pick(rentalCats).id,
      campusId: pick(campusIds),
      title: `出租 ${productNoun()} ${pick(PRODUCT_ADJ)}`,
      description: `${pick(PRODUCT_ADJ)}设备出租，${pick(DESCRIPTION_TAILS)}`,
      condition: pickWeighted([["LIKE_NEW", 40], ["LIGHTLY_USED", 35], ["NORMAL_USED", 25]]),
      price: price5to5000(),
      pricingUnit: pickWeighted([["PER_DAY", 60], ["PER_HOUR", 20], ["PER_WEEK", 20]]),
      depositAmount: Math.round((50 + rnd() * 500) * 100) / 100,
      minimumDuration: 1,
      maximumDuration: randInt(7, 90),
      pickupLocation: pick(LOCATIONS),
      returnLocation: pick(LOCATIONS),
      status: pickWeighted([["AVAILABLE", 90], ["PAUSED", 10]]),
      viewCount: fav * 8 + randInt(10, 300),
      favoriteCount: fav,
      createdAt: created,
      updatedAt: created,
      deletedAt: rnd() < 0.02 ? new Date(now - randInt(1, 90) * 86400000) : null,
    });
  }
  await insertBatched(prisma.rentalListing, rentals);

  console.log("[seed-perf] listing moderations（150 active + 300 resolved，目标互不重复）…");
  const mods = [];
  const usedProductIdx = new Set();
  for (let i = 0; i < 450; i++) {
    let idx = randInt(0, products.length - 1);
    while (usedProductIdx.has(idx)) idx = randInt(0, products.length - 1);
    usedProductIdx.add(idx);
    const product = products[idx];
    mods.push({
      id: `bmod${pad(i, 4)}`,
      targetType: "PRODUCT",
      productId: product.id,
      campusId: product.campusId,
      observedStatus: product.status,
      moderatorId: userIds[0],
      reasonCode: "SPAM_ADVERTISEMENT",
      resolvedAt: i < 150 ? null : new Date(now - randInt(1, 30) * 86400000),
      resolvedById: i < 150 ? null : userIds[0],
      createdAt: new Date(now - randInt(1, 60) * 86400000),
    });
  }
  await insertBatched(prisma.listingModeration, mods);

  const counts = await prisma.$transaction([
    prisma.product.count(),
    prisma.errandTask.count(),
    prisma.serviceListing.count(),
    prisma.rentalListing.count(),
    prisma.user.count(),
    prisma.listingModeration.count(),
  ]);
  console.log(
    `[seed-perf] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — products=${counts[0]} errands=${counts[1]} services=${counts[2]} rentals=${counts[3]} users=${counts[4]} moderations=${counts[5]}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
