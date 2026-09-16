-- Phase 7D：/governance/audit 审计可见性读面 additive 索引（仅 DDL）。
--
-- 合同（Phase 7D Planning 冻结）：
-- - 仅新增索引：不改任何列/约束/FK/行数据，不回填 campusId；
-- - 两个索引只优化 /governance/audit 的可见性/过滤查询执行
--   （默认最新序 createdAt DESC, id DESC 与 campus-scoped 过滤），
--   不定义任何 scope 语义——授权谓词独立于索引存在；
-- - btree 反向扫描即覆盖 DESC 排序，无需 DESC 索引语法。

CREATE INDEX "AdminLog_campusId_createdAt_id_idx" ON "AdminLog"("campusId", "createdAt", "id");

CREATE INDEX "AdminLog_createdAt_id_idx" ON "AdminLog"("createdAt", "id");
