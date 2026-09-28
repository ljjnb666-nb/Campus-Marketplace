import { describe, expect, it } from "vitest";

import { classifyStorageWriteError } from "@/lib/storage/s3-write-error-classifier";

/**
 * LR-R3 / R3-06 classifier regression：
 * 新引入的客户端超时（AbortError / TimeoutError）与既有网络错误必须保守
 * 归类 AMBIGUOUS——除非能严格证明请求从未发出（单 attempt + 连接建立阶段
 * 失败码）。恢复行为对两类错误一致（分类仅用于日志），因此这里验证的是
 * 可观测语义而非配额行为。
 */

/** 模拟 @smithy node handler 的真实错误形态 */
function sdkError(input: {
  name: string;
  code?: string;
  attempts?: number;
  message?: string;
}): Error {
  const error = new Error(input.message ?? input.name);
  error.name = input.name;
  if (input.code !== undefined) {
    Object.assign(error, { code: input.code });
  }
  if (input.attempts !== undefined) {
    Object.assign(error, {
      $metadata: { attempts: input.attempts },
    });
  }
  return error;
}

describe("classifyStorageWriteError", () => {
  it("ECONNREFUSED + 单次 attempt = DEFINITE_CONNECT_FAILURE（TCP 未建立，请求不可能送达）", () => {
    // @smithy 把 ECONNREFUSED 重命名为 TimeoutError，但保留 code
    const error = sdkError({ name: "TimeoutError", code: "ECONNREFUSED", attempts: 1 });

    expect(classifyStorageWriteError(error)).toMatchObject({
      errorClass: "DEFINITE_CONNECT_FAILURE",
      definitePreCommitFailure: true,
      attempts: 1,
      errorName: "TimeoutError",
      errorCode: "ECONNREFUSED",
    });
  });

  it("ENOTFOUND / EAI_AGAIN（DNS 阶段）+ 单次 attempt = DEFINITE", () => {
    expect(
      classifyStorageWriteError(sdkError({ name: "Error", code: "ENOTFOUND", attempts: 1 }))
        .definitePreCommitFailure,
    ).toBe(true);
    expect(
      classifyStorageWriteError(sdkError({ name: "Error", code: "EAI_AGAIN", attempts: 1 }))
        .definitePreCommitFailure,
    ).toBe(true);
  });

  it("ECONNREFUSED + 多次 attempt = AMBIGUOUS（前序 attempt 可能已提交后服务下线）", () => {
    const error = sdkError({ name: "TimeoutError", code: "ECONNREFUSED", attempts: 2 });

    expect(classifyStorageWriteError(error)).toMatchObject({
      errorClass: "AMBIGUOUS_WRITE_FAILURE",
      definitePreCommitFailure: false,
      attempts: 2,
    });
  });

  it("R3-06：客户端 abort（AbortError）= AMBIGUOUS——abort 不证明远端未提交", () => {
    const error = sdkError({ name: "AbortError", attempts: 1, message: "Request aborted" });

    expect(classifyStorageWriteError(error)).toMatchObject({
      errorClass: "AMBIGUOUS_WRITE_FAILURE",
      definitePreCommitFailure: false,
      attempts: 1,
    });
  });

  it("R3-06：connect/socket/request 各类 TimeoutError = AMBIGUOUS（无法证明字节未到达对端）", () => {
    // @smithy 三种超时统一命名为 TimeoutError（connect 阶段也会带该 name）
    const connectTimeout = sdkError({
      name: "TimeoutError",
      attempts: 1,
      message: "the request socket did not establish a connection with the server",
    });
    const socketTimeout = sdkError({
      name: "TimeoutError",
      attempts: 1,
      message: "the request socket timed out after 3000 ms of inactivity",
    });
    const requestTimeout = sdkError({
      name: "TimeoutError",
      code: "ETIMEDOUT",
      attempts: 1,
    });

    for (const error of [connectTimeout, socketTimeout, requestTimeout]) {
      expect(classifyStorageWriteError(error)).toMatchObject({
        errorClass: "AMBIGUOUS_WRITE_FAILURE",
        definitePreCommitFailure: false,
      });
    }
  });

  it("ECONNRESET（连接曾建立）= AMBIGUOUS——请求可能已发送且远端已提交", () => {
    // LR-071 的核心场景：response lost after commit 在 client 侧即此类错误
    const error = sdkError({ name: "TimeoutError", code: "ECONNRESET", attempts: 2 });

    expect(classifyStorageWriteError(error)).toMatchObject({
      errorClass: "AMBIGUOUS_WRITE_FAILURE",
      definitePreCommitFailure: false,
    });
  });

  it("HTTP 状态错误（无 code）= AMBIGUOUS", () => {
    const error = sdkError({ name: "Error", attempts: 2, message: "slow down" });
    Object.assign(error, { $metadata: { attempts: 2, httpStatusCode: 503 } });

    expect(classifyStorageWriteError(error)).toMatchObject({
      errorClass: "AMBIGUOUS_WRITE_FAILURE",
      attempts: 2,
      errorCode: null,
    });
  });

  it("无 $metadata（非 SDK 错误）= AMBIGUOUS，attempts 为 null", () => {
    expect(classifyStorageWriteError(new Error("boom"))).toEqual({
      errorClass: "AMBIGUOUS_WRITE_FAILURE",
      definitePreCommitFailure: false,
      attempts: null,
      errorName: "Error",
      errorCode: null,
    });
    expect(classifyStorageWriteError(undefined).errorClass).toBe("AMBIGUOUS_WRITE_FAILURE");
    expect(classifyStorageWriteError("oops").definitePreCommitFailure).toBe(false);
  });
});
