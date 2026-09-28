import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const script = path.join(repoRoot, "scripts", "ops", "ops-check.ts");

/**
 * OPS-REDIS-01/02/03（LAUNCH_REHEARSAL_REPAIR R1 / P1-01）：
 *
 * P1-01 根因是 enableOfflineQueue:false + 未 ready 即 ping → 健康 Redis
 * 被误报 FAIL。修复合同：lazyConnect → 显式 await connect() → ping →
 * disconnect。本文件必须用【真实 Redis】证明该合同（只 mock ioredis
 * 无法证明连接时序），沿用 redis-rate-limit 集成测试的
 * INTEGRATION_REDIS_URL 约定（CI 服务容器提供；未设置时跳过）。
 *
 * OPS-REDIS-01 健康 Redis → redis_connectivity pass
 * OPS-REDIS-02 不可达 endpoint → bounded fail，绝无 PASS 汇总
 * OPS-REDIS-03 错误密码 → fail（真实 WRONGPASS：临时对集成 Redis
 *   开启 requirepass 构造，finally 恢复）；正确密码 → pass（正控）；
 *   全程输出不得泄漏凭据
 *
 * 三个用例必须顺序执行：03 会临时改变服务端全局 requirepass 状态，
 * 与 01/02 并发会产生交叉污染（vitest fullyParallel 下同文件用例并行）。
 */

const integrationRedisUrl = process.env.INTEGRATION_REDIS_URL;

/** 运行时拼接的合成值：仅用于本测试自身的临时 requirepass，不是真实凭据 */
const SYNTH = {
  requirePass: ["R1SynthRequirePass-Only-", "ForIntegration-0123"].join(""),
  wrongPass: ["R1SynthWrongPass-Only-", "ForIntegration-0123"].join(""),
};

interface ExecOutcome {
  code?: number;
  stdout?: string;
}

/** 以指定 REDIS_URL 子进程运行 ops-check（与 ops-check.test.ts 同模式） */
async function runOpsCheck(redisUrl: string): Promise<{ outcome: ExecOutcome; cwd: string }> {
  const cwd = mkdtempSync(path.join(tmpdir(), "campus-ops-redis-"));
  const outcome = await execFileAsync(
    process.execPath,
    [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), script, "--mode", "development"],
    {
      // 临时 cwd：避免读到仓库根 .env.production 干扰
      cwd,
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: "",
        REDIS_URL: redisUrl,
        S3_ENDPOINT: "",
        BACKUP_DIR: "",
        RELEASE_SHA: "",
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  ).catch((error: ExecOutcome) => error);
  return { outcome, cwd };
}

function summaryOf(outcome: ExecOutcome): { result: string; failed: string[] } {
  return JSON.parse((outcome.stdout ?? "").trim().split("\n").at(-1)!);
}

function redisLineOf(outcome: ExecOutcome): { status: string; detail?: string } {
  return JSON.parse(
    (outcome.stdout ?? "").trim().split("\n").find((l) => l.includes('"name":"redis_connectivity"'))!,
  );
}

function urlWithPassword(password: string): string {
  const u = new URL(integrationRedisUrl!);
  u.password = password;
  return u.toString();
}

// vitest 3.x 修饰符链不支持 sequential.skipIf 组合，运行时二选一：
// 无 INTEGRATION_REDIS_URL → 整组 skip；有 → sequential（03 会临时修改
// 服务端全局 requirepass，必须与 01/02 顺序执行，避免交叉污染）。
const sequentialSuite = integrationRedisUrl ? describe.sequential : describe.skip;

sequentialSuite(
  "ops-check redis_connectivity（真实 Redis，R1 P1-01 合同）",
  () => {
    let inspector: Redis;
    const tmpDirs: string[] = [];

    const run = async (url: string) => {
      const { outcome, cwd } = await runOpsCheck(url);
      tmpDirs.push(cwd);
      return outcome;
    };

    afterAll(async () => {
      await Promise.resolve(inspector?.disconnect()).catch(() => undefined);
      for (const dir of tmpDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("OPS-REDIS-01：健康 Redis → redis_connectivity=pass（真实 PONG，非 mock）", async () => {
      inspector = new Redis(integrationRedisUrl!, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
      // 集成前置真实性守卫：inspector ping 失败 = 环境无真实 Redis，判 FAIL
      expect(await inspector.ping()).toBe("PONG");

      const outcome = await run(integrationRedisUrl!);
      // promisify(execFile) 成功时无 code 字段（仅失败时带非 0 code）
      expect(outcome.code ?? 0).toBe(0);
      const summary = summaryOf(outcome);
      expect(summary.result).toBe("PASS");
      expect(redisLineOf(outcome).status).toBe("pass");
      // 修复 P1-01 的核心断言：健康 Redis 绝不允许把 redis_connectivity
      // 拉进 failed 列表（旧实现此处会因 offline-queue 拒绝而 FAIL）
      expect(summary.failed).not.toContain("redis_connectivity");
    });

    it("OPS-REDIS-02：不可达 endpoint → bounded fail，绝无 PASS 汇总", async () => {
      const u = new URL(integrationRedisUrl!);
      // 端口 9 = discard，本机几乎必然 ECONNREFUSED（与既有 DB fail 测试同约定）
      u.port = "9";
      const startedAt = Date.now();
      const outcome = await run(u.toString());
      const elapsedMs = Date.now() - startedAt;

      expect(outcome.code).not.toBe(0);
      expect(redisLineOf(outcome).status).toBe("fail");
      // bounded：connect timeout 4s + 进程启动开销，绝不允许无限挂起
      expect(elapsedMs).toBeLessThan(15_000);
      // 绝无 PASS 汇总
      expect(outcome.stdout).not.toMatch(/"result":"PASS"/);
      expect(summaryOf(outcome).result).toBe("FAIL");
      expect(summaryOf(outcome).failed).toContain("redis_connectivity");
      // 无连接串/地址泄漏（host:port 属部署拓扑信息，同样不得出现在输出）
      expect(outcome.stdout).not.toContain(u.host);
    });

    it(
      "OPS-REDIS-03：错误密码 → fail 且不泄漏凭据；正确密码 → pass（正控）",
      { timeout: 60_000 },
      async () => {
        inspector =
          inspector ??
          new Redis(integrationRedisUrl!, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
        // 仅当集成 Redis 允许 CONFIG 且当前无密码时执行（CI 服务容器满足）
        const current = (await inspector.config("GET", "requirepass")) as unknown as
          | string[]
          | null;
        if (!current || current[1] !== "") {
          console.log("SKIP OPS-REDIS-03：集成 Redis 不允许临时 requirepass（受管实例）");
          return;
        }

        // 临时开启 requirepass 构造真实 WRONGPASS 场景；finally 无条件恢复
        await inspector.config("SET", "requirepass", SYNTH.requirePass);
        let authedRestore: Redis | null = null;
        try {
          // 错误密码 → fail（真实 WRONGPASS，非 mock）
          const wrong = await run(urlWithPassword(SYNTH.wrongPass));
          expect(wrong.code).not.toBe(0);
          expect(redisLineOf(wrong).status).toBe("fail");
          expect(summaryOf(wrong).failed).toContain("redis_connectivity");
          expect(summaryOf(wrong).result).toBe("FAIL");
          // 绝不泄漏错误密码/真实密码/连接串
          expect(wrong.stdout).not.toContain(SYNTH.wrongPass);
          expect(wrong.stdout).not.toContain(SYNTH.requirePass);
          expect(wrong.stdout).not.toMatch(/redis:\/\/[^\s"]*:/);

          // 正控：正确密码 → pass（证明凭据真实参与认证，而非任何密码都放行）
          const right = await run(urlWithPassword(SYNTH.requirePass));
          expect(right.code ?? 0).toBe(0);
          expect(redisLineOf(right).status).toBe("pass");
          expect(summaryOf(right).failed).not.toContain("redis_connectivity");
          expect(right.stdout).not.toContain(SYNTH.requirePass);
        } finally {
          authedRestore = new Redis(urlWithPassword(SYNTH.requirePass), {
            maxRetriesPerRequest: 1,
            connectTimeout: 2000,
          });
          try {
            await authedRestore.config("SET", "requirepass", "");
            const restored = (await inspector.config("GET", "requirepass")) as unknown as string[];
            expect(restored[1]).toBe("");
          } finally {
            await Promise.resolve(authedRestore.disconnect()).catch(() => undefined);
          }
        }
      },
    );
  },
);

