require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({ log: [] });

(async () => {
  // 诊断：enforcement.read permission 重复？
  const perms = await p.$queryRawUnsafe(
    `SELECT id, key, count(*) OVER (PARTITION BY key) AS cnt FROM "Permission" WHERE key = 'enforcement.read'`,
  );
  console.log(perms.map(x => ({ id: x.id, key: x.key })));
  const dupRoles = await p.$queryRawUnsafe(
    `SELECT r.key, count(*) AS n FROM "Role" r WHERE r."isSystem" = true GROUP BY r.key HAVING count(*) > 1`,
  );
  console.log(dupRoles.map(x => ({ key: x.key, n: Number(x.n) })));
  const dupAssign = await p.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "UserRoleAssignment" a JOIN "Role" r ON a."roleId" = r.id WHERE r.key = 'PLATFORM_ADMIN'`,
  );
  console.log("PLATFORM_ADMIN assignments:", dupAssign[0].n);
  await p.$disconnect();
})().catch((e) => {
  console.error(String(e.message).slice(0, 300));
  process.exit(1);
});
