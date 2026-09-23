-- Repair 2 (RB-01)：Legacy Verification Evidence Closure（DATA-ONLY，零 DDL）。
--
-- Root finding（三轮全系统审计）：UserVerification.studentCardImage 自 init
-- migration 起就是普通 TEXT，历史值允许 /uploads/ 直链、http(s) 外链与任意
-- 未知字符串，可绕过 asset:<id> 私有资产访问模型（/api/assets 鉴权 +
-- asset.sensitive.read / verification.evidence.read + sensitive access audit）。
-- Migration chain 从未证明历史数据被转换。
--
-- 本迁移把一切非受控证据值清空为 ''（"材料不可用"状态），实现 DATA CLOSURE：
-- - 仅受控 asset:<id> 引用（唯一合法形态）与 'erased' 注销哨兵保留；
-- - PENDING/VERIFIED/REJECTED 各状态的认证结论一律不变（不得自动改判，
--   Repair 2 合同 §8）；审核页对已清空行显示"历史认证材料不可用"；
-- - RUNTIME CLOSURE 由代码层承担（PrivateAssetViewer fail-closed +
--   resolveVerificationEvidenceDisplay + zod/service 提交校验），
--   即使旧备份/手工恢复重新引入 raw 值也无法再被渲染为链接。
--
-- 硬合同：
-- - 显式事务：BEGIN / COMMIT 显式包裹（Prisma Migrate 不自动包事务）；
-- - 不改任何表/列/枚举/索引/FK（SCHEMA_CHANGE_REQUIRED = NO）；
-- - 幂等：重复执行第二次 WHERE 不命中任何行（bounded, observable）；
-- - 不产生任何外部副作用（无网络 / 无对象存储访问）。
--
-- 迁移后核验查询（LEGACY_READABLE_ROWS_AFTER_REPAIR 期望 = 0）：
--   SELECT COUNT(*) FROM "UserVerification"
--   WHERE "studentCardImage" NOT LIKE 'asset:%'
--     AND "studentCardImage" <> 'erased'
--     AND "studentCardImage" <> '';

BEGIN;

UPDATE "UserVerification"
SET "studentCardImage" = ''
WHERE "studentCardImage" NOT LIKE 'asset:%'
  AND "studentCardImage" <> 'erased'
  AND "studentCardImage" <> '';

COMMIT;
