import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  APPROVED_RETENTION_EXCEPTIONS,
  DECLARED_NON_PERSONAL_FIELDS,
  ERASURE_FIELD_COVERAGE,
  ERASURE_IMPLEMENTATION_MODELS,
  ERASURE_MODES,
  FROZEN_PERSONAL_MODELS,
  GOVERNANCE_FIELD_POLICIES,
  LISTING_USER_CONTENT_FIELD_POLICIES,
  MODEL_PRIVACY_POLICIES,
  PRIVACY_DATA_CLASSES,
  SENSITIVE_FIELD_EXPECTATIONS,
  SENSITIVE_FIELD_NAME_PATTERN,
  SELF_EXPORT_MODES,
  USER_INPUT_FIELD_EXPECTATIONS,
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
      if (!fieldName) {
        continue;
      }
      // 跳过块声明行本身（"model X {"），但保留合法的字段名 `model`
      if (fieldName === "model" && /^model\s+\w+\s+\{/.test(line)) {
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
      ...LISTING_USER_CONTENT_FIELD_POLICIES,
    ]) {
      const key = `${policy.model}.${policy.field}`;
      expect(seen.has(key), `重复分类：${key}`).toBe(false);
      seen.add(key);
    }
  });
});


describe("REGISTRY-06/07/08：persisted user-input 字段全生命周期覆盖（FIELD-COVERAGE GAP 修复）", () => {
  it("REGISTRY-06：每条 USER_INPUT_FIELD_EXPECTATIONS 都有 registry field policy", () => {
    expect(USER_INPUT_FIELD_EXPECTATIONS.length).toBeGreaterThanOrEqual(30);

    const unclassified = USER_INPUT_FIELD_EXPECTATIONS.filter(
      (entry) => getFieldPrivacyPolicy(entry.model, entry.field) === null,
    ).map((entry) => `${entry.model}.${entry.field}`);

    expect(unclassified, "用户输入字段未分类（MODEL_PRESENT != FIELDS_CLASSIFIED）").toEqual([]);
  });

  it("REGISTRY-07（=REGISTRY-03 合同对 user-input 面）：user-input 字段 erasure ∈ {CLEAR, REDACT}", () => {
    const violations = USER_INPUT_FIELD_EXPECTATIONS.map((entry) => ({
      entry,
      policy: getFieldPrivacyPolicy(entry.model, entry.field)!,
    }))
      .filter(
        ({ policy }) =>
          policy.classification === "USER_AUTHORED_CONTENT" &&
          policy.erasure !== "CLEAR" &&
          policy.erasure !== "REDACT",
      )
      .map(({ entry, policy }) => `${entry.model}.${entry.field}=${policy.erasure}`);

    expect(violations, "user-input 字段不得 RETAIN_STRUCTURAL/RETAIN_GOVERNANCE").toEqual([]);
  });

  it("REGISTRY-08：USER_INPUT_FIELD_EXPECTATIONS ⊆ ERASURE_FIELD_COVERAGE（字段级执行登记）", () => {
    const missing = USER_INPUT_FIELD_EXPECTATIONS.filter(
      (entry) => !ERASURE_FIELD_COVERAGE.has(`${entry.model}.${entry.field}`),
    ).map((entry) => `${entry.model}.${entry.field}`);

    expect(missing, "用户输入字段缺少字段级 erasure 执行登记").toEqual([]);
  });

  it("ERASURE_FIELD_COVERAGE 无死键（每个登记键都是已分类字段）", () => {
    for (const key of ERASURE_FIELD_COVERAGE) {
      const [model, field] = key.split(".");
      expect(
        getFieldPrivacyPolicy(model, field),
        `ERASURE_FIELD_COVERAGE 死键（registry 无此分类）：${key}`,
      ).not.toBeNull();
    }
  });

  it("机器字段不入 user-input 面（enum/money/count/timestamp 不得误分类）", () => {
    const machineSamples: Array<[string, string]> = [
      ["Product", "price"],
      ["Product", "condition"],
      ["RentalListing", "depositAmount"],
      ["Order", "amount"],
      ["ErrandTask", "reward"],
      ["RentalOrder", "startTime"],
      ["SupportTicket", "status"],
    ];
    for (const [model, field] of machineSamples) {
      const policy = getFieldPrivacyPolicy(model, field);
      expect(
        policy === null || policy.classification !== "USER_AUTHORED_CONTENT",
        `${model}.${field} 是机器/结构字段，不得分类为 USER_AUTHORED_CONTENT`,
      ).toBe(true);
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
      ...LISTING_USER_CONTENT_FIELD_POLICIES,
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

describe("REGISTRY-03：USER_AUTHORED_CONTENT 不得 RETAIN_*（R4-03 语义不变量）", () => {
  it("任何字段 policy：classification=USER_AUTHORED_CONTENT ⇒ erasure ∈ {CLEAR, REDACT}", () => {
    const allPolicies = [
      ...SENSITIVE_FIELD_EXPECTATIONS,
      ...GOVERNANCE_FIELD_POLICIES,
      ...LISTING_USER_CONTENT_FIELD_POLICIES,
    ];

    const violations = allPolicies
      .filter(
        (policy) =>
          policy.classification === "USER_AUTHORED_CONTENT" &&
          policy.erasure !== "CLEAR" &&
          policy.erasure !== "REDACT",
      )
      .map((policy) => `${policy.model}.${policy.field}=${policy.erasure}`);

    expect(
      violations,
      "STRUCTURAL ROW RETENTION != USER CONTENT RETENTION：row 保留由 MODEL policy 表达，user-authored 字段必须 CLEAR/REDACT",
    ).toEqual([]);
  });

  it("不存在 approved retention exception（本轮 = 0）", () => {
    expect(APPROVED_RETENTION_EXCEPTIONS.size).toBe(0);
  });
});

describe("REGISTRY-04：DIRECT_IDENTITY 非空列不得声明不可执行的 CLEAR", () => {
  // 切块 + 逐行解析（避免 RegExp 构造器的转义层级歧义）
  function schemaModelBlock(model: string): string | null {
    const marker = `model ${model} {`;
    const start = schemaText.indexOf(marker);
    if (start < 0) {
      return null;
    }
    const end = schemaText.indexOf("\n}", start);
    return end < 0 ? null : schemaText.slice(start, end);
  }

  function schemaFieldType(model: string, fieldName: string): string | null {
    const block = schemaModelBlock(model);
    if (!block) {
      return null;
    }
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith(`${fieldName} `)) {
        return line.split(/\s+/)[1] ?? null;
      }
    }
    return null;
  }

  it("DIRECT_IDENTITY 字段：非空列必须 REDACT/PSEUDONYMIZE；可空列才允许 CLEAR", () => {
    const directIdentityFields = [
      ...SENSITIVE_FIELD_EXPECTATIONS,
      ...GOVERNANCE_FIELD_POLICIES,
      ...LISTING_USER_CONTENT_FIELD_POLICIES,
    ].filter((policy) => policy.classification === "DIRECT_IDENTITY");

    expect(directIdentityFields.length).toBeGreaterThan(0);

    for (const policy of directIdentityFields) {
      const fieldType = schemaFieldType(policy.model, policy.field);
      expect(fieldType, `${policy.model}.${policy.field} 不在 schema`).not.toBeNull();
      const isNullable = fieldType!.endsWith("?");
      if (!isNullable) {
        expect(
          policy.erasure,
          `${policy.model}.${policy.field}（非空 ${fieldType}）不可声明 CLEAR——运行时只能 REDACT/PSEUDONYMIZE`,
        ).not.toBe("CLEAR");
      }
    }
  });

  it("明确覆盖：User.schoolName = DIRECT_IDENTITY / REDACT（非空列哨兵替换）", () => {
    const policy = getFieldPrivacyPolicy("User", "schoolName");
    expect(policy).not.toBeNull();
    expect(policy!.classification).toBe("DIRECT_IDENTITY");
    expect(policy!.erasure).toBe("REDACT");

    const fieldType = schemaFieldType("User", "schoolName");
    expect(fieldType).toBe("String");
    expect(fieldType!.endsWith("?")).toBe(false);
  });
});

describe("REGISTRY-05：每个 user-authored 字段必须有 erasure 执行覆盖（exception=0）", () => {
  const erasureSource = readFileSync(
    resolve(process.cwd(), "src", "lib", "privacy", "account-erasure.ts"),
    "utf8",
  );

  it("含 USER_AUTHORED_CONTENT 字段的 model 全部在 account-erasure 执行路径中出现", () => {
    const allPolicies = [
      ...SENSITIVE_FIELD_EXPECTATIONS,
      ...GOVERNANCE_FIELD_POLICIES,
      ...LISTING_USER_CONTENT_FIELD_POLICIES,
    ];

    const userAuthoredModels = new Set(
      allPolicies
        .filter((policy) => policy.classification === "USER_AUTHORED_CONTENT")
        .map((policy) => policy.model),
    );

    const missing: string[] = [];
    for (const model of userAuthoredModels) {
      if (ERASURE_IMPLEMENTATION_MODELS.has(model)) {
        // Prisma client 访问形式（camelCase）必须出现在 erasure 源码中
        const clientAccessor = model.charAt(0).toLowerCase() + model.slice(1);
        expect(
          erasureSource.includes(`client.${clientAccessor}`) ||
            erasureSource.includes(`tx.${clientAccessor}`),
          `model ${model} 声明为 USER_AUTHORED_CONTENT 但 account-erasure.ts 无执行路径`,
        ).toBe(true);
      } else if (!APPROVED_RETENTION_EXCEPTIONS.has(model)) {
        missing.push(model);
      }
    }

    expect(missing, "未登记执行路径且无 approved exception 的 model").toEqual([]);
  });
});
