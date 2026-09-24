import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DECLARED_NON_PERSONAL_FIELDS,
  ERASURE_MODES,
  FROZEN_PERSONAL_MODELS,
  GOVERNANCE_FIELD_POLICIES,
  MODEL_PRIVACY_POLICIES,
  PRIVACY_DATA_CLASSES,
  RETAINED_USER_CONTENT_FIELD_POLICIES,
  SENSITIVE_FIELD_EXPECTATIONS,
  SENSITIVE_FIELD_NAME_PATTERN,
  SELF_EXPORT_MODES,
  getFieldPrivacyPolicy,
  getModelPrivacyPolicy,
} from "@/lib/privacy/privacy-data-registry";

/**
 * REGISTRY-01/02：隐私分类注册表 completeness + drift gate。
 *
 * REGISTRY-01：全部冻结 personal-bearing models 在 registry 中有明确 policy；
 * 规格冻结的敏感字段全部被分类。
 *
 * REGISTRY-02：Prisma schema 中任何命中敏感命名启发式的 (model, field)
 * 必须被注册表显式分类（三张 policy 表之一）或列入非个人 allowlist，
 * 否则测试失败并要求人工 classification。这是 CI drift detector，
 * 不是运行时安全边界。
 */

type SchemaField = { model: string; field: string };

function parseSchemaModelFields(schemaText: string): SchemaField[] {
  const fields: SchemaField[] = [];
  const modelBlocks =
    schemaText.match(/^model\s+(\w+)\s+\{[\s\S]*?^\}/gm) ?? [];

  for (const block of modelBlocks) {
    const modelName = block.match(/^model\s+(\w+)/)?.[1];
    if (!modelName) {
      continue;
    }
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) {
        continue;
      }
      const fieldName = line.split(/\s+/)[0];
      if (!fieldName || fieldName === "model") {
        continue;
      }
      fields.push({ model: modelName, field: fieldName });
    }
  }

  return fields;
}

function parseSchemaModelNames(schemaText: string): string[] {
  return [...schemaText.matchAll(/^model\s+(\w+)\s+\{/gm)].map((match) => match[1]);
}

const schemaText = readFileSync(
  resolve(process.cwd(), "prisma", "schema.prisma"),
  "utf8",
);

const schemaFields = parseSchemaModelFields(schemaText);
const schemaModelNames = parseSchemaModelNames(schemaText);

describe("REGISTRY-01：冻结 personal models 全部分类（completeness）", () => {
  it("16 个冻结 personal-bearing models 全部有 model 级 policy", () => {
    expect(FROZEN_PERSONAL_MODELS).toHaveLength(16);

    for (const model of FROZEN_PERSONAL_MODELS) {
      const policy = getModelPrivacyPolicy(model);
      expect(policy, `model ${model} 缺少 registry policy`).not.toBeNull();
      expect(SELF_EXPORT_MODES).toContain(policy!.selfExport);
      expect(ERASURE_MODES).toContain(policy!.erasure);
    }
  });

  it("冻结 model 全部真实存在于 Prisma schema（防拼写漂移）", () => {
    for (const model of FROZEN_PERSONAL_MODELS) {
      expect(schemaModelNames, `registry model ${model} 不在 schema 中`).toContain(model);
    }
  });

  it("规格冻结的敏感字段全部被字段级分类（消失即 FAIL）", () => {
    const frozenExpectations: Array<[string, string]> = [
      ["User", "email"],
      ["User", "phone"],
      ["User", "name"],
      ["User", "avatarUrl"],
      ["User", "bio"],
      ["User", "studentIdLast4"],
      ["User", "passwordHash"],
      ["UserVerification", "studentCardImage"],
      ["UserVerification", "reviewNote"],
      ["Message", "content"],
      ["Review", "content"],
      ["RentalReview", "content"],
      ["Report", "detail"],
      ["Appeal", "statement"],
      ["Notification", "content"],
      ["Order", "note"],
      ["Order", "cancelReason"],
      ["RentalOrder", "renterNote"],
      ["RentalOrder", "cancellationNote"],
      ["RentalOrderStatusLog", "note"],
      ["RentalDispute", "reason"],
      ["SupportTicket", "subject"],
      ["SupportTicket", "description"],
      ["SupportTicket", "resolutionMessage"],
      ["SupportTicket", "internalNote"],
      ["UploadedAsset", "originalFileName"],
      ["UploadedAsset", "objectKey"],
      ["UploadedAsset", "bucket"],
      ["PrivacyRequest", "handledNote"],
    ];

    for (const [model, fieldName] of frozenExpectations) {
      const policy = getFieldPrivacyPolicy(model, fieldName);
      expect(policy, `${model}.${fieldName} 从 registry 消失`).not.toBeNull();
      expect(PRIVACY_DATA_CLASSES).toContain(policy!.classification);
    }
  });

  it("关键隐私红线：operator/credential/storage-internal 面绝不 self-export", () => {
    const mustExclude: Array<[string, string]> = [
      ["User", "passwordHash"],
      ["UserVerification", "studentCardImage"],
      ["UserVerification", "reviewNote"],
      ["Report", "handledNote"],
      ["Appeal", "decisionNote"],
      ["RentalDispute", "adminNote"],
      ["SupportTicket", "internalNote"],
      ["UploadedAsset", "objectKey"],
      ["UploadedAsset", "bucket"],
      ["PrivacyRequest", "handledNote"],
    ];

    for (const [model, fieldName] of mustExclude) {
      const policy = getFieldPrivacyPolicy(model, fieldName);
      expect(policy).not.toBeNull();
      expect(
        policy!.selfExport,
        `${model}.${fieldName} 必须 SELF_EXPORT=EXCLUDE`,
      ).toBe("EXCLUDE");
    }
  });

  it("policy 表之间无 (model, field) 重复键", () => {
    const seen = new Set<string>();
    for (const policy of [
      ...SENSITIVE_FIELD_EXPECTATIONS,
      ...GOVERNANCE_FIELD_POLICIES,
      ...RETAINED_USER_CONTENT_FIELD_POLICIES,
    ]) {
      const key = `${policy.model}.${policy.field}`;
      expect(seen.has(key), `重复分类：${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe("REGISTRY-02：schema 敏感字段 drift gate", () => {
  it("schema 中每个命中敏感命名启发式的字段都被显式分类或豁免", () => {
    const nonPersonal = new Set(
      DECLARED_NON_PERSONAL_FIELDS.map((entry) => `${entry.model}.${entry.field}`),
    );

    const unclassified: string[] = [];
    for (const { model, field: fieldName } of schemaFields) {
      if (!SENSITIVE_FIELD_NAME_PATTERN.test(fieldName)) {
        continue;
      }
      const key = `${model}.${fieldName}`;
      if (getFieldPrivacyPolicy(model, fieldName)) {
        continue;
      }
      if (nonPersonal.has(key)) {
        continue;
      }
      unclassified.push(key);
    }

    expect(
      unclassified,
      "未分类敏感命名字段（须在 privacy-data-registry 人工分类）：",
    ).toEqual([]);
  });

  it("allowlist 条目仍然真实存在于 schema（防过期豁免掩盖新增漂移）", () => {
    for (const { model, field: fieldName } of DECLARED_NON_PERSONAL_FIELDS) {
      expect(
        schemaFields.some((entry) => entry.model === model && entry.field === fieldName),
        `allowlist 条目 ${model}.${fieldName} 已不存在于 schema`,
      ).toBe(true);
    }
  });

  it("分类条目也仍然真实存在于 schema（防字段删除后残留死条目）", () => {
    for (const policy of [
      ...SENSITIVE_FIELD_EXPECTATIONS,
      ...GOVERNANCE_FIELD_POLICIES,
      ...RETAINED_USER_CONTENT_FIELD_POLICIES,
    ]) {
      expect(
        schemaFields.some(
          (entry) => entry.model === policy.model && entry.field === policy.field,
        ),
        `分类条目 ${policy.model}.${policy.field} 已不存在于 schema`,
      ).toBe(true);
    }
  });
});
