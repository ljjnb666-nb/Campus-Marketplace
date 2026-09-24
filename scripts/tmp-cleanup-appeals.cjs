require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({ log: [] });

(async () => {
  // 清理本地库中历次集成运行遗留的 fixture Appeal（隔离 proof 用，非生产数据）
  const users = await p.$queryRawUnsafe(
    `SELECT id FROM "User" WHERE email LIKE '%@it.local' OR email LIKE '%@e2e.test' OR email LIKE '%@erased.invalid'`,
  );
  const userIds = users.map((u) => u.id);
  console.log("fixture users:", userIds.length);

  if (userIds.length === 0) {
    await p.$disconnect();
    return;
  }

  // Appeal 挂在 EnforcementAction 上（appellant = 被执法用户）
  const actions = await p.$queryRawUnsafe(
    `SELECT id, "targetId" FROM "EnforcementAction" WHERE "targetId" = ANY($1::text[])`,
    userIds,
  );
  const actionIds = actions.map((a) => a.id);
  console.log("enforcement actions:", actionIds.length);

  let deleted = 0;
  if (actionIds.length > 0) {
    const r = await p.$executeRawUnsafe(
      `DELETE FROM "Appeal" WHERE "enforcementActionId" = ANY($1::text[])`,
      actionIds,
    );
    deleted = r;
  }
  console.log("appeals deleted:", deleted);

  const total = await p.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Appeal"`);
  console.log("appeals remaining total:", total[0].n);
  await p.$disconnect();
})().catch((e) => {
  console.error(String(e.message).slice(0, 300));
  process.exit(1);
});
