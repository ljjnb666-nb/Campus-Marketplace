"use client";

import { useState } from "react";

import {
  parseAssetReference,
  parseVerificationEvidenceReference,
  CONTROLLED_EVIDENCE,
} from "@/lib/asset-ref";

interface PrivateAssetViewerProps {
  /** 业务字段保存的图片值：仅受控 asset:<id> 可查看；其余值 fail closed */
  value: string;
  label?: string;
}

/**
 * 私有资源查看入口（RB-01 Repair 2 fail-closed）：
 * - 仅严格合法的 asset:<id> 经签名接口换取同源代理 URL 后展示；
 * - 历史 /uploads/ 直链、外链、任意未知/畸形字符串一律渲染为
 *   "历史认证材料不可用" 的非交互状态——绝不进入 href/src/DOM，
 *   使历史证据值无法绕过 /api/assets 的鉴权边界。
 */
export function PrivateAssetViewer({ value, label = "查看材料" }: PrivateAssetViewerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [signedUrl, setSignedUrl] = useState<string>("");

  if (parseVerificationEvidenceReference(value) !== CONTROLLED_EVIDENCE) {
    return (
      <span className="inline-block text-sm text-slate-500" data-evidence-unavailable="true">
        历史认证材料不可用
      </span>
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
      const assetId = parseAssetReference(value);
      if (!assetId) {
        throw new Error("无法获取材料访问权限");
      }
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
