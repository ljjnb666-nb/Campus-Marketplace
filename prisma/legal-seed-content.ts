/**
 * Phase 5 法务/平台政策文档：初始工程治理基线内容。
 *
 * 供 prisma/seed.ts 与 scripts/e2e-setup.ts 共用（tsx 无 @/ alias，
 * 本模块只使用相对导入与 @prisma/client）。
 *
 * 红线（与 docs/LEGAL_GOVERNANCE.md 一致）：
 * - LEGAL_REVIEW_REQUIRED = TRUE：本文本是工程/产品治理基线，
 *   不声称"完全符合中国法律 / 已通过 PIPL 合规"；公开上线前必须
 *   完成真实法律/合规审查并替换为审查后的版本（发布新版本即可）。
 * - 不虚构法定保存年限、备案状态、支付资质、监管审批。
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type PolicySeedDocument = {
  type: "TERMS_OF_SERVICE" | "PRIVACY_POLICY" | "PLATFORM_RULES" | "PROHIBITED_TRANSACTIONS";
  version: number;
  title: string;
  content: string;
};

const LEGAL_REVIEW_NOTICE =
  "【文档状态说明】本文档为平台工程/产品治理基线文本（LEGAL_REVIEW_REQUIRED = TRUE）。" +
  "在平台正式公开发布前，全部法务文本仍需通过真实法律与合规审查；审查后如需修改，" +
  "将以此处可追溯的新版本形式发布，历史版本在本页存档。";

export const POLICY_SEED_DOCUMENTS: PolicySeedDocument[] = [
  {
    type: "TERMS_OF_SERVICE",
    version: 1,
    title: "校园集市用户服务协议",
    content: `${LEGAL_REVIEW_NOTICE}

一、平台定位
校园集市是面向高校学生的二手商品、校园跑腿、技能服务与闲置租赁信息平台。
平台提供信息发布、撮合与沟通工具，不参与、不担保任何线下交易的资金环节。
当前阶段全部交易采用线下面对面交付与支付语义；平台不经手、不托管任何交易资金。

二、账号
1. 注册需提供有效的邮箱地址并设置符合复杂度要求的密码。
2. 你应对账号下的全部行为负责，不得出借、转让账号。
3. 平台可以在你违反本协议或平台规则时，视情节采取内容下架、限制功能、
   停用账号等治理措施，并保留相关治理记录。

三、信息发布与交易
1. 发布的信息必须真实，不得包含虚假价格、虚假库存或误导性描述。
2. 交易双方的沟通与交付应通过平台内工具留痕，避免脱离平台私下约定后
   发生纠纷无法举证。
3. 校园认证仅表示平台对提交材料的审核结论，不构成对用户信用或交易的担保。

四、协议变更
本协议按版本管理。发布新版本时，平台将要求受影响用户在继续使用前
重新阅读并确认；未经你确认的新版本不会自动对你产生"已同意"的记录。

五、其他
1. 本协议的成立、效力与平台治理规则以平台实际提供的功能为准。
2. 对本协议内容或平台治理措施的疑问，可通过平台内举报与反馈渠道提出。
`,
  },
  {
    type: "PRIVACY_POLICY",
    version: 1,
    title: "校园集市隐私政策",
    content: `${LEGAL_REVIEW_NOTICE}

一、我们收集的信息（最小必要）
1. 账号资料：昵称、邮箱（登录标识）、密码（仅以不可逆哈希保存）、学校与校区。
2. 可选资料：头像、学院、年级、手机号、学号后四位（用于校园认证核对）。
3. 校园认证材料：学生证照片等，仅用于认证审核；审核完成后原图按保留期
   自动删除，仅保留审核结论。
4. 业务数据：你发布的商品/跑腿/服务/租赁信息、订单与评价、站内消息、
   举报记录，以及你对平台协议的同意记录。
5. 运行数据：用于排障的请求标识与服务运行日志（不包含内容本体，
   见《日志隐私与保留策略》）。

二、信息的使用
1. 公开可见的信息仅限：昵称、头像、学校、校区、认证状态与信用统计。
2. 以下信息不公开：完整学号、学生证图片、手机号、身份证号、精确宿舍地址、
   密码哈希、内部治理备注。
3. 站内消息仅对话双方可见；举报材料仅举报相关处理角色可见。

三、你的权利
1. 查看与更正：你可以在个人中心查看并更正自己的资料。
2. 数据导出：你可以在"隐私与数据"页面申请导出本人数据副本。
   导出仅包含你自己的数据与必要的公共信息，不包含他人私密数据。
3. 注销账号：你可以申请注销。注销后账号将无法登录，个人可识别信息
   将被删除或匿名化；为维持交易与治理记录的完整性，历史订单、评价等
   以匿名化形式保留。
4. 同意管理：你可以随时查看自己的协议同意历史；平台协议版本更新时，
   我们会要求你重新确认。

四、保留与删除
1. 校园认证等敏感材料按既定保留期删除（当前为审核后 30 天）。
2. 存在法律冻结或纠纷冻结（Data Hold）的数据，在冻结解除前不会被
   破坏性删除。
3. 各类数据的保留策略以《数据治理说明》（docs/DATA_GOVERNANCE.md
   的用户可见摘要）为准；涉及法定保存年限的条目以待法律审查标注。

五、安全措施
密码以 bcrypt 哈希保存；私有上传经权限校验后以短时签名访问；
日志出口统一脱敏；上传内容经过安全处理并剥离位置等元数据。

六、联系我们
如对本政策或你的个人数据处理有疑问，请通过平台内反馈渠道联系我们。
`,
  },
  {
    type: "PLATFORM_RULES",
    version: 1,
    title: "校园集市平台规则",
    content: `${LEGAL_REVIEW_NOTICE}

一、允许发布的内容
1. 二手商品：合法的自有闲置物品。
2. 校园跑腿：取送、代买、排队等校园内劳务任务。
3. 技能服务：课程辅导、题目讲解、编程答疑、作业批改、PPT 排版、
   格式调整、资料整理等不违反学术诚信与法律的服务。
4. 闲置租赁：可供短租的自有物品。

二、禁止行为
1. 学术不诚信：代写作业/论文、代考替考、考试作弊相关的一切服务与交易。
2. 违法违禁：发布或交易法律法规禁止的物品与服务。
3. 非法金融：任何形式的集资、放贷、代充值跑分、洗钱等行为。
4. 违规账号：买卖、租借账号，或利用平台账号实施欺诈。
5. 欺诈与绕过治理：虚假信息、钓鱼链接、诱导脱离平台实施诈骗、
   规避平台治理措施的行为。
6. 资金池：利用平台建立任何形式的资金池、非法集资或未经许可的结算体系。

三、治理措施
违反上述规则的内容将被下架；情节严重的账号将被限制功能或停用。
平台对举报进行审核，并保留治理记录作为后续处理的依据。

四、执行说明
平台规则的执行以当前产品实际具备的治理能力为准；随着平台治理能力
（审核、申诉、信用体系）分阶段建设，规则执行方式会同步更新并以
新版本形式发布。
`,
  },
  {
    type: "PROHIBITED_TRANSACTIONS",
    version: 1,
    title: "禁止交易与结算红线",
    content: `${LEGAL_REVIEW_NOTICE}

一、永久禁止的交易类型
以下类型在任何阶段都不得在本平台发布、撮合或执行：
1. 代写作业/论文、代考替考等学术不诚信交易；
2. 违禁品、危险品、侵权盗版物品交易；
3. 账号买卖与账号租赁；
4. 非法金融服务：集资、放贷、代收代付跑分、虚拟货币交易等；
5. 以"兼职""刷单"为名的诈骗与资金归集行为。

二、资金与结算红线
1. 平台不提供资金托管、担保支付或任何形式的资金池服务；
2. 平台不得以"普通商家收款码 + 平台截留 + 人工转卖家"的方式
   处理交易资金（该模式不是合规的市场结算基础设施）；
3. 当前阶段全部交易为线下面对面交付与支付，平台不经手资金；
4. 未来如引入在线支付，必须由持牌支付机构承担收付款、分账、
   结算与退款，且需另行完成相应合规审查。

三、违规处理
触碰上述红线的发布与交易将被直接下架并封禁相关账号；
涉嫌违法犯罪的，平台将依法配合有关部门处理。
`,
  },
];

/** canonical content 哈希：与 src/lib/legal/legal-document-service.ts 的
 * computeContentHash 保持同一规则（UTF-8 原文 SHA-256，hex 小写）。 */
export function seedComputeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * 发布初始策略文档（v1）。幂等：已存在同 (type, version) 时跳过。
 * 生产环境初始发布同样走本内容（由部署后的一次性 seed 流程或运营
 * 手动发布完成；迁移本身不写业务数据）。
 */
export async function seedPublishedPolicies(prisma: PrismaClient): Promise<void> {
  for (const document of POLICY_SEED_DOCUMENTS) {
    const existing = await prisma.legalDocument.findUnique({
      where: { type_version: { type: document.type, version: document.version } },
    });

    if (existing) {
      continue;
    }

    await prisma.legalDocument.create({
      data: {
        type: document.type,
        version: document.version,
        status: "PUBLISHED",
        title: document.title,
        content: document.content,
        contentHash: seedComputeContentHash(document.content),
        effectiveAt: new Date(),
        publishedAt: new Date(),
        requiresAcceptance: true,
      },
    });
  }
}

/**
 * 【TEST FIXTURE ONLY】为 E2E 账号显式插入同意证据。
 *
 * 这不是生产 migration 的做法——生产旧用户必须走 /legal/accept 的真实
 * 重新同意流程（禁止迁移伪造同意）。本函数只能被 E2E 基建调用。
 */
export async function createTestFixtureAcceptance(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  const documents = await prisma.legalDocument.findMany({
    where: {
      status: "PUBLISHED",
      requiresAcceptance: true,
      effectiveAt: { lte: new Date() },
    },
  });

  for (const document of documents) {
    await prisma.policyAcceptance.upsert({
      where: { userId_documentId: { userId, documentId: document.id } },
      update: {},
      create: {
        userId,
        documentId: document.id,
        documentType: document.type,
        documentVersion: document.version,
        documentHash: document.contentHash,
        source: "SIGNUP",
        acceptedAt: new Date(),
      },
    });
  }
}
