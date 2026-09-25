import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// vitest 以仓库根为 cwd（npm run test）
const repoRoot = process.cwd();

/**
 * RB-06（§42）：静态不可变镜像 gate。
 *
 * .github/workflows/ci.yml 与 compose.production.yml 中的 MinIO / mc 镜像
 * 一律 immutable digest pin，禁止 :latest / 任何 floating tag。
 * 未来更新镜像时必须显式替换 digest（流程见 docs/PRODUCTION_DEPLOYMENT.md），
 * 本测试强制这一点——不得回退为 floating tag。
 *
 * 范围冻结说明（§43）：仅 MinIO/mc（已登记的 mutable-image debt）。
 * postgres/redis/node/caddy 等 base image 不在本 gate 范围内。
 */

const FILES = [".github/workflows/ci.yml", "compose.production.yml"] as const;

/** 本轮（2026-09-25）由 authenticated pull + docker inspect RepoDigests 取得 */
const EXPECTED_DIGESTS = {
  "ghcr.io/ljjnb666-nb/minio": "sha256:a1a8bd4ac40ad7881a245bab97323e18f971e4d4cba2c2007ec1bedd21cbaba2",
  "ghcr.io/ljjnb666-nb/mc": "sha256:eb4ea9884b77704230e2423e9004d2fa738dc272876b9cc41a297d29443b8780",
  "minio/minio": "sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
  "minio/mc": "sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727",
} as const;

/** MinIO/mc 镜像引用（可选 :tag）+ 可选 @sha256 digest */
const IMAGE_REF =
  /(ghcr\.io\/ljjnb666-nb\/(?:minio|mc)|minio\/(?:minio|mc))(:[^\s@"']+)?(@sha256:[0-9a-f]{64})?/g;

function findRefs(text: string): Array<{ full: string; name: string; tag?: string; digest?: string }> {
  return [...text.matchAll(IMAGE_REF)].map((match) => ({
    full: match[0],
    name: match[1],
    tag: match[2],
    digest: match[3],
  }));
}

/** 去掉 YAML 注释（注释中提及镜像名不算 image 引用） */
function stripComments(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

describe("静态镜像不可变 gate（MinIO/mc digest pin）", () => {
  for (const file of FILES) {
    it(`${file} 中 MinIO/mc 镜像全部 digest pin 且 digest 与批准值一致`, () => {
      const content = stripComments(readFileSync(path.join(repoRoot, file), "utf8"));
      const refs = findRefs(content);

      // 范围确认：gate 所针对的镜像确实出现（防止 regex 失效静默通过）
      expect(refs.length, `${file} 应包含 MinIO/mc 镜像引用`).toBeGreaterThan(0);

      for (const ref of refs) {
        expect(ref.tag, `${file}: ${ref.full} 不得携带 floating tag`).toBeUndefined();
        expect(ref.digest, `${file}: ${ref.full} 必须 @sha256 digest pin`).toBeDefined();
        expect(
          ref.digest,
          `${file}: ${ref.full} digest 与批准值不一致（更新必须走 docs/PRODUCTION_DEPLOYMENT.md 的镜像更新流程并同步本 gate）`,
        ).toBe(`@${EXPECTED_DIGESTS[ref.name as keyof typeof EXPECTED_DIGESTS]}`);
      }
    });

    it(`${file} 不得出现 minio/mc :latest floating tag（§42）`, () => {
      const content = stripComments(readFileSync(path.join(repoRoot, file), "utf8"));
      for (const floating of [
        "minio/minio:latest",
        "minio/mc:latest",
        "ljjnb666-nb/minio:latest",
        "ljjnb666-nb/mc:latest",
      ]) {
        expect(content).not.toContain(floating);
      }
    });
  }
});
