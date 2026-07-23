CREATE TABLE "ServiceCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServiceCategory_slug_key" ON "ServiceCategory"("slug");

INSERT INTO "ServiceCategory" ("id", "name", "slug", "description", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES
  ('svc_cat_photography', '摄影', 'photography', '校园约拍、活动跟拍、证件照等摄影服务', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_video-editing', '视频剪辑', 'video-editing', '课程作业、Vlog、活动回顾等视频剪辑服务', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_graphic-design', '平面设计', 'graphic-design', '海报、封面、社团物料等平面设计服务', 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_ppt-design', 'PPT制作', 'ppt-design', '答辩、汇报、竞赛等 PPT 美化与制作', 3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_computer-repair', '电脑维修', 'computer-repair', '系统重装、故障排查、软件安装等', 4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_programming-tutoring', '编程辅导', 'programming-tutoring', '代码答疑、项目指导、开发环境配置', 5, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_course-tutoring', '课程辅导', 'course-tutoring', '课程答疑、题目讲解、知识点梳理', 6, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_music-practice', '乐器陪练', 'music-practice', '钢琴、吉他等乐器练习陪练', 7, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_fitness-coaching', '健身陪练', 'fitness-coaching', '跑步、力量训练、基础动作指导', 8, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_event-support', '活动协助', 'event-support', '校园活动执行、主持协助、现场支持', 9, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_pet-care', '宠物照顾', 'pet-care', '临时喂养、遛宠、照看等宠物相关服务', 10, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('svc_cat_other-service', '其他服务', 'other-service', '其他未归类的校园技能服务', 11, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

ALTER TABLE "ServiceListing" ADD COLUMN "categoryId" TEXT;

UPDATE "ServiceListing"
SET "categoryId" = 'svc_cat_other-service'
WHERE "categoryId" IS NULL;

ALTER TABLE "ServiceListing" ALTER COLUMN "categoryId" SET NOT NULL;

CREATE INDEX "ServiceListing_categoryId_status_idx" ON "ServiceListing"("categoryId", "status");

ALTER TABLE "ServiceListing" ADD CONSTRAINT "ServiceListing_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
