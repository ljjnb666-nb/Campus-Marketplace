import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 10D Risk Intelligence (real PostgreSQL)",
  () => {
    let prisma: PrismaClient;
    let campusA = "";
    let campusB = "";
    let targetUserId = "";
    let loadAuthorizedRiskIntelligence:
      typeof import("@/lib/risk/risk-intelligence")["loadAuthorizedRiskIntelligence"];

    beforeAll(async () => {
      prisma = new PrismaClient({
        datasources: { db: { url: integrationDatabaseUrl } },
        log: ["error"],
      });
      await prisma.$connect();
      ({ loadAuthorizedRiskIntelligence } = await import(
        "@/lib/risk/risk-intelligence"
      ));

      const suffix = randomUUID().slice(0, 8);
      const [a, b] = await Promise.all([
        prisma.campus.create({
          data: {
            name: "P10D Campus A",
            slug: `p10d-a-${suffix}`,
            schoolName: "集成测试大学 A",
          },
        }),
        prisma.campus.create({
          data: {
            name: "P10D Campus B",
            slug: `p10d-b-${suffix}`,
            schoolName: "集成测试大学 B",
          },
        }),
      ]);
      campusA = a.id;
      campusB = b.id;

      const target = await prisma.user.create({
        data: {
          name: "P10D target",
          email: `p10d-target-${suffix}@it.local`,
          passwordHash: "test-only",
          schoolName: "集成测试大学 A",
          campusId: campusA,
        },
      });
      targetUserId = target.id;

      await prisma.riskFlag.createMany({
        data: [
          {
            userId: targetUserId,
            campusId: campusA,
            kind: "REPORT_SUBMITTED",
            severity: "INFO",
            sourceType: "REPORT",
            sourceId: `p10d-a-${suffix}`,
          },
          {
            userId: targetUserId,
            campusId: campusB,
            kind: "REPORT_CONFIRMED",
            severity: "MEDIUM",
            sourceType: "REPORT",
            sourceId: `p10d-b-${suffix}`,
          },
          {
            userId: targetUserId,
            campusId: null,
            kind: "MANUAL_FLAG",
            severity: "HIGH",
            sourceType: "MANUAL",
            sourceId: `p10d-global-${suffix}`,
          },
        ],
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await prisma.riskFlag.deleteMany({ where: { userId: targetUserId } });
      await prisma.riskState.deleteMany({ where: { userId: targetUserId } });
      await prisma.enforcementAction.deleteMany({ where: { targetId: targetUserId } });
      await prisma.user.deleteMany({ where: { id: targetUserId } });
      await prisma.campus.deleteMany({ where: { id: { in: [campusA, campusB] } } });
      await prisma.$disconnect();
    });

    it("P10D-PG-01: campus scope is SQL-isolated and neutral allegation stays OBSERVE", async () => {
      const assessment = await loadAuthorizedRiskIntelligence({
        access: { global: false, campusIds: [campusA] },
        targetUserId,
        campusId: campusA,
        evaluatedAt: new Date("2026-10-08T00:00:00.000Z"),
      });

      expect(assessment).toMatchObject({
        scope: { kind: "CAMPUS", campusId: campusA },
        attentionLevel: "OBSERVE",
        recommendedAction: "MONITOR",
        activeSignalCount: 1,
      });
      expect(assessment.signalBreakdown).toEqual([
        { kind: "REPORT_SUBMITTED", severity: "INFO", count: 1 },
      ]);
      expect(assessment.evidence.every((row) => row.campusId === campusA)).toBe(true);
    });

    it("P10D-PG-02: another campus confirmed report does not bleed across scope", async () => {
      const assessment = await loadAuthorizedRiskIntelligence({
        access: { global: false, campusIds: [campusB] },
        targetUserId,
        campusId: campusB,
      });

      expect(assessment).toMatchObject({
        scope: { kind: "CAMPUS", campusId: campusB },
        attentionLevel: "REVIEW",
        recommendedAction: "OPERATOR_REVIEW",
        activeSignalCount: 1,
      });
      expect(assessment.signalBreakdown).toEqual([
        { kind: "REPORT_CONFIRMED", severity: "MEDIUM", count: 1 },
      ]);
    });

    it("P10D-PG-03: GLOBAL reader sees all scopes; evaluation writes zero enforcement state", async () => {
      const before = await Promise.all([
        prisma.riskState.count({ where: { userId: targetUserId } }),
        prisma.enforcementAction.count({ where: { targetId: targetUserId } }),
      ]);

      const assessment = await loadAuthorizedRiskIntelligence({
        access: { global: true, campusIds: [] },
        targetUserId,
      });

      expect(assessment).toMatchObject({
        scope: { kind: "ALL_SCOPES" },
        attentionLevel: "PRIORITY_REVIEW",
        recommendedAction: "PRIORITY_OPERATOR_REVIEW",
        activeSignalCount: 3,
      });

      const after = await Promise.all([
        prisma.riskState.count({ where: { userId: targetUserId } }),
        prisma.enforcementAction.count({ where: { targetId: targetUserId } }),
      ]);
      expect(after).toEqual(before);
    });

    it("P10D-PG-04: unauthorized campus is rejected before any data read result", async () => {
      await expect(
        loadAuthorizedRiskIntelligence({
          access: { global: false, campusIds: [campusA] },
          targetUserId,
          campusId: campusB,
        }),
      ).rejects.toThrow("RISK_INTELLIGENCE_SCOPE_DENIED");
    });
  },
);
