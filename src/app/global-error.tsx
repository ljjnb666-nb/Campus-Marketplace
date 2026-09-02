"use client";

import { useEffect } from "react";

/**
 * 全局错误边界（TASK 12）：root layout 级别故障（error.tsx 覆盖不到的
 * layout 渲染失败）的最后防线。
 *
 * 安全契约：用户只看到通用提示 + digest 参考编号 + 重试入口；
 * stack / 内部路径 / 凭据 / 原始异常绝不进入 UI。
 * 服务端异常详情由 Next 以 digest 形式记录在服务端日志中（经 logger
 * redaction 脱敏），浏览器侧只保留与用户沟通所需的随机参考编号。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 浏览器控制台保留（开发者排障）；不向任何第三方上报
    console.error(error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          backgroundColor: "#f8fafc",
          color: "#0f172a",
        }}
      >
        <main style={{ maxWidth: 560, padding: "48px 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: 28, marginBottom: 12 }}>应用出现严重错误</h1>
          <p style={{ color: "#475569", lineHeight: 1.7 }}>
            应用核心框架加载失败，请刷新页面重试。
          </p>
          {error.digest ? (
            <p style={{ color: "#64748b", fontSize: 14 }}>
              参考编号：<code style={{ fontFamily: "monospace" }}>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 24,
              padding: "12px 28px",
              borderRadius: 9999,
              border: "none",
              backgroundColor: "#0f172a",
              color: "#ffffff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </main>
      </body>
    </html>
  );
}
