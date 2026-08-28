"use client";

import { useState } from "react";

interface PrivateAssetViewerProps {
  /** 业务字段保存的图片值：asset:<id>、公开 URL 或历史 /uploads/ 路径 */
  value: string;
  label?: string;
}

/**
 * 私有资源查看入口：asset:<id> 经签名接口换取短时 URL 后展示；
 * 历史 /uploads/ 或外链值直接作为链接打开（存量兼容）。
 * 签名 URL 短期有效（默认 5 分钟），过期后重新点击即可。
 */
export function PrivateAssetViewer({ value, label = "查看材料" }: PrivateAssetViewerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [signedUrl, setSignedUrl] = useState<string>("");

  if (!value.startsWith("asset:")) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-slate-950 underline"
      >
        {label}
      </a>
    );
  }

  const handleView = async () => {
    if (signedUrl) {
      window.open(signedUrl, "_blank", "noreferrer");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const assetId = value.slice("asset:".length);
      const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/access`);
      const result = (await response.json()) as { url?: string; message?: string };
      if (!response.ok || !result.url) {
        throw new Error(result.message || "无法获取材料访问权限");
      }
      setSignedUrl(result.url);
      window.open(result.url, "_blank", "noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法获取材料访问权限");
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={handleView}
        disabled={loading}
        className="inline-block w-fit text-left text-slate-950 underline disabled:opacity-60"
      >
        {loading ? "正在获取访问权限..." : `${label}（已加密，点击查看）`}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
